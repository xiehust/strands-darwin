/** Bounded, Unicode-safe presentation of tool inputs and results. */

export type ToolPreviewStatus = 'ok' | 'error' | 'denied';

export const COMPACT_RESULT_CODE_POINTS = 2_000;
export const COMPACT_RESULT_LINES = 4;
export const EXPANDED_INPUT_CODE_POINTS = 8_000;
export const EXPANDED_INPUT_LINES = 100;
export const EXPANDED_RESULT_CODE_POINTS = 32_000;
export const EXPANDED_RESULT_LINES = 200;

export interface TextBounds {
  codePoints: number;
  lines: number;
}

/** JSON when possible, a defensive string fallback otherwise. */
export function serializeToolInput(input: unknown): string {
  try {
    // Pretty-print in expanded mode so structured input is inspectable and the
    // independent logical-line bound has useful work to do. This is only a TUI
    // projection; the SDK retains and receives the original input object.
    const json = JSON.stringify(input, null, 2);
    if (json !== undefined) return json;
  } catch {
    // Fall through to the one representation still available.
  }
  try {
    return String(input);
  } catch {
    return '[unprintable input]';
  }
}

/** Expanded tool input, bounded from the head because inputs read in source order. */
export function expandedToolInput(input: unknown): string[] {
  return boundText(serializeToolInput(input), 'ok', {
    codePoints: EXPANDED_INPUT_CODE_POINTS,
    lines: EXPANDED_INPUT_LINES,
  });
}

/** Result preview for the mode selected when the call completed. */
export function toolResultPreview(
  preview: string,
  status: ToolPreviewStatus,
  expanded: boolean,
): string[] {
  return boundText(preview, status, expanded
    ? { codePoints: EXPANDED_RESULT_CODE_POINTS, lines: EXPANDED_RESULT_LINES }
    : { codePoints: COMPACT_RESULT_CODE_POINTS, lines: COMPACT_RESULT_LINES });
}

/**
 * Applies independent logical-line and code-point caps without splitting a
 * surrogate pair. Success keeps the head, errors the tail, and denials retain
 * their leading reason plus the diagnostic tail.
 */
export function boundText(text: string, status: ToolPreviewStatus, bounds: TextBounds): string[] {
  if (text.trim() === '' || bounds.codePoints <= 0 || bounds.lines <= 0) return [];

  const sourceLines = text.split('\n');
  const originalPoints = [...text].length;
  let kept: string[];

  switch (status) {
    case 'ok':
      kept = takeHead(sourceLines, bounds.lines, bounds.codePoints);
      break;
    case 'error':
      kept = takeTail(sourceLines, bounds.lines, bounds.codePoints);
      break;
    case 'denied':
      kept = takeDenied(sourceLines, bounds.lines, bounds.codePoints);
      break;
  }

  const keptText = kept.join('\n');
  if (keptText === text) return kept;

  const omittedPoints = Math.max(0, originalPoints - [...keptText].length);
  const omittedLines = Math.max(0, sourceLines.length - kept.length);
  const marker = truncationMarker(omittedPoints, omittedLines);

  if (status === 'ok') return [...kept, marker];
  if (status === 'error') return [marker, ...kept];
  if (kept.length <= 1) return [...kept, marker];
  return [kept[0] as string, marker, ...kept.slice(1)];
}

function takeHead(lines: readonly string[], lineLimit: number, pointLimit: number): string[] {
  const candidate = lines.slice(0, lineLimit).join('\n');
  return [...candidate].slice(0, pointLimit).join('').split('\n');
}

function takeTail(lines: readonly string[], lineLimit: number, pointLimit: number): string[] {
  const candidate = lines.slice(-lineLimit).join('\n');
  return [...candidate].slice(-pointLimit).join('').split('\n');
}

function takeDenied(lines: readonly string[], lineLimit: number, pointLimit: number): string[] {
  const first = lines[0] ?? '';
  if (lines.length === 1 || lineLimit === 1) {
    return [[...first].slice(0, pointLimit).join('')];
  }

  const firstPoints = [...first];
  if (firstPoints.length >= pointLimit) return [firstPoints.slice(0, pointLimit).join('')];

  const tail = lines.slice(1).slice(-(lineLimit - 1)).join('\n');
  const tailBudget = Math.max(0, pointLimit - firstPoints.length - 1);
  // `slice(-0)` is `slice(0)`, not an empty slice. Without this guard, a
  // denial whose reason consumes all but the separating newline budget would
  // retain its entire tail and bypass the code-point cap.
  if (tailBudget === 0) return [first];
  const keptTail = [...tail].slice(-tailBudget).join('');
  return keptTail === '' ? [first] : [first, ...keptTail.split('\n')];
}

function truncationMarker(omittedPoints: number, omittedLines: number): string {
  const points = `${omittedPoints} code point${omittedPoints === 1 ? '' : 's'}`;
  const lines = omittedLines === 0
    ? ''
    : ` and ${omittedLines} line${omittedLines === 1 ? '' : 's'}`;
  return `… truncated ${points}${lines}`;
}

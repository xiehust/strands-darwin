/** Presentation only: one counted search row, never query or accepted prompt state. */
export function searchPreview(text: string): string {
  // truncate-end bounds width, not explicit line breaks. Treat CRLF as one break;
  // VT/FF/NEL and Unicode line/paragraph separators must not move the terminal either.
  return text
    .replace(/\r\n|[\r\n\u000b\u000c\u0085\u2028\u2029]/g, ' ⏎ ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (control) =>
      `\\u${control.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Minimal terminal-state reducer for assertions about visible scrollback.
 *
 * Accumulated pty bytes cannot prove that a live row was later erased: the text
 * remains in the byte stream either way. This replays only the cursor and erase
 * sequences Ink emits, which is enough to inspect the user's resulting terminal
 * buffer without introducing a general terminal emulator.
 */
const ESC = '\u001B';

function params(raw: string): number[] {
  return raw.split(';').map((value) => value === '' ? Number.NaN : Number(value));
}

export function reconstructTerminalLines(output: string, rows: number): string[] {
  const scrollback: string[] = [];
  const screen = Array.from({ length: rows }, () => '');
  let row = 0;
  let column = 0;

  const lineFeed = (): void => {
    row += 1;
    if (row < rows) return;
    scrollback.push(screen.shift() ?? '');
    screen.push('');
    row = rows - 1;
  };

  for (let index = 0; index < output.length; index += 1) {
    const character = output[index] as string;
    if (character === ESC && output[index + 1] === '[') {
      let end = index + 2;
      let raw = '';
      while (end < output.length && /[\d;?]/.test(output[end] as string)) {
        raw += output[end] as string;
        end += 1;
      }
      const final = output[end] ?? '';
      index = end;
      if (raw.startsWith('?')) continue;

      const values = params(raw);
      const first = Number.isNaN(values[0]) ? undefined : values[0];
      switch (final) {
        case 'A': row = Math.max(0, row - (first ?? 1)); break;
        case 'B': row = Math.min(rows - 1, row + (first ?? 1)); break;
        case 'E': row = Math.min(rows - 1, row + (first ?? 1)); column = 0; break;
        case 'F': row = Math.max(0, row - (first ?? 1)); column = 0; break;
        case 'G': column = (first ?? 1) - 1; break;
        case 'd': row = (first ?? 1) - 1; break;
        case 'H':
        case 'f': {
          const second = Number.isNaN(values[1]) ? undefined : values[1];
          row = (first ?? 1) - 1;
          column = (second ?? 1) - 1;
          break;
        }
        case 'J':
          if (first === 2) screen.fill('');
          else if (first === 3) scrollback.length = 0;
          else {
            screen[row] = (screen[row] ?? '').slice(0, column);
            for (let next = row + 1; next < rows; next += 1) screen[next] = '';
          }
          break;
        case 'K':
          if (first === 2) screen[row] = '';
          else if (first === 1) {
            screen[row] = ' '.repeat(column) + (screen[row] ?? '').slice(column);
          } else screen[row] = (screen[row] ?? '').slice(0, column);
          break;
        default:
          break;
      }
      continue;
    }

    switch (character) {
      case '\r': column = 0; break;
      case '\n': lineFeed(); break;
      case '\b': column = Math.max(0, column - 1); break;
      case ESC: break;
      default: {
        if (character < ' ') break;
        const current = screen[row] ?? '';
        const padded = current.length < column
          ? current + ' '.repeat(column - current.length)
          : current;
        screen[row] = padded.slice(0, column) + character + padded.slice(column + 1);
        column += 1;
      }
    }
  }

  return [...scrollback, ...screen].map((line) => line.replace(/\s+$/u, ''));
}

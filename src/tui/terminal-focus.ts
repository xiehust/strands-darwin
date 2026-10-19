/** Narrow DECSET 1004 adapter at Ink's public render(stdin) seam.
 * Ink retains keyboard/paste parsing. Raw-mode suspension releases the real tty
 * for the external editor. No focus is inferred from silence or terminal identity.
 */
import { PassThrough } from 'node:stream';

export class TerminalFocusInput extends PassThrough {
  readonly isTTY: boolean;
  /** Ink only consumes the Readable/raw-mode subset; socket operations stay on source. */
  get stdin(): NodeJS.ReadStream { return this as unknown as NodeJS.ReadStream; }
  private raw = false;
  private listener: ((focused: boolean | undefined) => void) | undefined;
  private reporting = false;
  private pending = '';
  private pasted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly source: NodeJS.ReadStream, private readonly output: NodeJS.WriteStream) {
    super(); this.isTTY = source.isTTY;
  }
  get isRaw(): boolean { return this.source.isRaw; }
  ref(): this { this.source.ref(); return this; }
  unref(): this { this.source.unref(); return this; }
  setRawMode(value: boolean): this {
    this.source.setRawMode(value); this.raw = value;
    this.source.off('readable', this.readSource);
    if (value) { this.source.setEncoding('utf8'); this.source.on('readable', this.readSource); }
    else { this.clearPending(); this.pending = ''; this.pasted = false; while (this.read() !== null) { /* discard suspended input */ } }
    this.updateReporting();
    return this;
  }
  watch(listener: (focused: boolean | undefined) => void): () => void {
    this.listener = listener; this.updateReporting();
    return () => { this.listener?.(undefined); this.listener = undefined; this.updateReporting(); };
  }
  close(): void {
    this.listener = undefined; this.raw = false; this.updateReporting();
    this.source.off('readable', this.readSource); this.clearPending();
    this.pending = ''; this.destroy();
  }
  private updateReporting(): void {
    const next = this.raw && this.listener !== undefined && this.isTTY && this.output.isTTY && process.env['TERM'] !== 'dumb';
    if (next === this.reporting) return;
    this.reporting = next;
    this.output.write(next ? '\u001b[?1004h' : '\u001b[?1004l');
    if (!next) { this.listener?.(undefined); this.clearPending(); this.pending = ''; this.pasted = false; }
  }
  private clearPending(): void { clearTimeout(this.timer); this.timer = undefined; }
  private readonly readSource = (): void => {
    let chunk: string | Buffer | null;
    while ((chunk = this.source.read() as string | Buffer | null) !== null) {
      if (!this.reporting) this.write(chunk);
      else this.filterFocus(String(chunk));
    }
  };

  private filterFocus(chunk: string): void {
    this.clearPending(); this.pending += chunk;
    let text = '';
    const sequences = ['\u001b[I', '\u001b[O', '\u001b[200~', '\u001b[201~'];
    while (this.pending !== '') {
      const sequence = sequences.find(value => this.pending.startsWith(value));
      if (sequence !== undefined) {
        this.pending = this.pending.slice(sequence.length);
        if (sequence === sequences[2]) { this.pasted = true; text += sequence; }
        else if (sequence === sequences[3]) { this.pasted = false; text += sequence; }
        else if (this.pasted) text += sequence;
        else {
          // Flush keyboard bytes first. Publication checks immediate composer owners
          // after the complete raw chunk has been consumed by Ink.
          const focused = sequence === sequences[0];
          const listener = this.listener;
          queueMicrotask(() => { if (this.reporting && this.listener === listener) listener?.(focused); });
        }
      } else if (sequences.some(value => value.startsWith(this.pending))) break;
      else { text += this.pending[0]; this.pending = this.pending.slice(1); }
    }
    if (text !== '') this.write(text);
    if (this.pending !== '') this.timer = setTimeout(() => {
      const rest = this.pending; this.pending = ''; this.timer = undefined;
      if (rest !== '') this.write(rest);
    }, 50);
  }
}

/** One-cell motion shared by live tools and background activity; the App owns the clock. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export function spinnerFrame(frame: number): string {
  return FRAMES[frame % FRAMES.length]!;
}

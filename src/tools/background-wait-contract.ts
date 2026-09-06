/** Shared provider/manager/presentation constants for bounded background waits. */
export const OUTPUT_SENSITIVE_WAIT_MAX_MS = 30_000;
// Explicit `wakeOnOutput: false` only: supervised headless children routinely run 20–30 minutes,
// and each wake costs a full-context model call that emits nothing but the next `wait`.
export const TERMINAL_FOCUSED_WAIT_MAX_MS = 1_800_000;
export const TERMINAL_WAIT_TIMEOUT_INSTRUCTION =
  'The task is still running. If later work depends on its completion, call bash wait again before ending this turn; background completion does not resume the agent.';
// The wake variant is truthful only where a driver drains SER-069 task wakes (the interactive
// TUI with `backgroundTaskWake` on); headless runs and children keep the sentence above.
export const TERMINAL_WAIT_TIMEOUT_INSTRUCTION_WAKE =
  'The task is still running. You may end this turn: once the session is idle, one <task-notification> turn delivers its state and output tail. Call bash wait again only when you need the result inside this turn.';

/** The `instruction` a still-running terminal-focused wait returns, per runtime. */
export function terminalWaitTimeoutInstruction(completionWakes: boolean): string {
  return completionWakes ? TERMINAL_WAIT_TIMEOUT_INSTRUCTION_WAKE : TERMINAL_WAIT_TIMEOUT_INSTRUCTION;
}

/** Either variant, for presentation code that classifies a wait result. */
export function isTerminalWaitTimeoutInstruction(value: unknown): boolean {
  return value === TERMINAL_WAIT_TIMEOUT_INSTRUCTION || value === TERMINAL_WAIT_TIMEOUT_INSTRUCTION_WAKE;
}

/** The `bash` description sentence about a still-running terminal-focused timeout, per runtime. */
export function backgroundCompletionSentence(completionWakes: boolean): string {
  return completionWakes
    ? 'A still-running terminal-focused timeout tells you that when later work depends on completion you may end the turn: once the session is idle, one <task-notification> turn delivers the job\'s state and output tail; wait is still right when you need the result inside this turn.'
    : 'A still-running terminal-focused timeout tells you to call wait again before ending when later work depends on completion; background completion does not resume the agent.';
}

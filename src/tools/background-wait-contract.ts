/** Shared provider/manager/presentation constants for bounded background waits. */
export const OUTPUT_SENSITIVE_WAIT_MAX_MS = 30_000;
// Explicit `wakeOnOutput: false` only: supervised headless children routinely run 20–30 minutes,
// and each wake costs a full-context model call that emits nothing but the next `wait`.
export const TERMINAL_FOCUSED_WAIT_MAX_MS = 1_800_000;
export const TERMINAL_WAIT_TIMEOUT_INSTRUCTION =
  'The task is still running. If later work depends on its completion, call bash wait again before ending this turn; background completion does not resume the agent.';

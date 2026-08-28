/** Shared provider/manager/presentation constants for bounded background waits. */
export const OUTPUT_SENSITIVE_WAIT_MAX_MS = 30_000;
export const TERMINAL_FOCUSED_WAIT_MAX_MS = 300_000;
export const TERMINAL_WAIT_TIMEOUT_INSTRUCTION =
  'The task is still running. If later work depends on its completion, call bash wait again before ending this turn; background completion does not resume the agent.';

/**
 * The `/workflow` built-in — a prompt-style trigger for the parent-only
 * `workflow` DAG tool, never a second execution channel.
 *
 * Expansion produces one fixed-template prompt that goes down the ordinary
 * submit path, so the model still owns DAG decomposition and every node still
 * crosses the permission gate. This module therefore stays pure: it never
 * constructs nodes, never imports `WorkflowTool`, and never touches the
 * runtime. The parse grammar deliberately mirrors `expandCustomCommand` (trim,
 * leading `/`, name up to the first whitespace, case-insensitive), so the
 * built-in and the custom commands it is reserved against cannot disagree
 * about what a slash command looks like. A missing task is the *drivers'*
 * local usage notice, never a fabricated turn — the runtime maps
 * `'missing-task'` to null.
 */

export const WORKFLOW_COMMAND_NAME = 'workflow';

/** The bounded local usage notice, shared by the TUI and dev-repl. */
export const WORKFLOW_COMMAND_USAGE =
  '/workflow orchestrates a task with the workflow tool: /workflow <task description>';

/**
 * The fixed instruction template. It restates the tool's own contract — the
 * node bound, what an edge means, and the reads-parallel / writes-serialized
 * rule — and embeds the user's description verbatim under a `Task:` marker.
 * The escape hatch is deliberate: the command steers the model toward the
 * tool, it does not force an indivisible task through it.
 */
function workflowPrompt(task: string): string {
  return (
    'Orchestrate this task with the `workflow` tool: decompose it into a bounded DAG of at ' +
    'most 8 subagent nodes, where each [source, target] edge both orders the work and hands ' +
    'the source\u2019s final report to the target as input. Concurrent nodes share one ' +
    'working tree, so parallel branches are for reads only \u2014 serialize writes by edges. ' +
    'If the task is truly indivisible, handle it directly and say why a workflow does not ' +
    'fit.\n\n' +
    `Task: ${task}`
  );
}

/**
 * Recognizes `/workflow`, leaving all other input untouched (`null`). A bare
 * or whitespace-only invocation is `'missing-task'`; otherwise the expanded
 * prompt is returned.
 */
export function parseWorkflowCommand(
  input: string,
): { message: string } | 'missing-task' | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const withoutSlash = trimmed.slice(1);
  const separator = withoutSlash.search(/\s/);
  const name = separator === -1 ? withoutSlash : withoutSlash.slice(0, separator);
  if (name.toLowerCase() !== WORKFLOW_COMMAND_NAME) return null;

  const task = separator === -1 ? '' : withoutSlash.slice(separator).trim();
  if (task === '') return 'missing-task';
  return { message: workflowPrompt(task) };
}

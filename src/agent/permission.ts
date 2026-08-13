/**
 * Permission gating for tool calls.
 *
 * Built on the SDK's intervention framework: a handler passed via
 * `AgentConfig.interventions` gets `beforeToolCall` for every call and returns
 * proceed or deny. Denial becomes an error tool result the model reads and
 * responds to, so the agent loop keeps running.
 *
 * Approval is decided by an injected {@link PermissionBridge}, so the same gate
 * drives a readline prompt today and the Ink prompt later.
 */
import { InterventionActions, InterventionHandler } from '@strands-agents/sdk';
import type { BeforeToolCallEvent } from '@strands-agents/sdk';

/**
 * The `InterventionAction` union is not re-exported from the package root and
 * `./interventions` has no subpath export, so derive it from the base class.
 */
type InterventionAction = Awaited<ReturnType<InterventionHandler['beforeToolCall']>>;

/** How a tool call is classified. `read` calls run without asking. */
export type PermissionKind = 'read' | 'write' | 'execute';

/**
 * What the UI needs to render a confirmation. `summary` is a one-line headline;
 * `details` holds the parts worth showing in full (a command, or a file path
 * plus the replacement text).
 */
export interface PermissionRequest {
  toolName: string;
  kind: PermissionKind;
  /** Single-line description, e.g. `bash: pnpm typecheck`. */
  summary: string;
  /** Labelled blocks for multi-line rendering, in display order. */
  details: PermissionDetail[];
  /** Raw tool input, for a UI that wants to show or diff it itself. */
  input: unknown;
}

export interface PermissionDetail {
  label: string;
  value: string;
}

/**
 * Asks the human to approve one tool call. Resolves true to allow.
 *
 * Implementations may block for as long as they need — the SDK awaits
 * intervention callbacks serially, so the agent loop waits.
 */
export type PermissionBridge = (request: PermissionRequest) => Promise<boolean>;

/** Approves everything without asking. For non-interactive runs and tests. */
export const allowAllBridge: PermissionBridge = async () => true;

export class PermissionGate extends InterventionHandler {
  readonly name = 'strands-darwin:permission-gate';

  constructor(private readonly ask: PermissionBridge) {
    super();
  }

  override async beforeToolCall(event: BeforeToolCallEvent): Promise<InterventionAction> {
    const request = classify(event.toolUse.name, event.toolUse.input);

    if (request.kind === 'read') {
      return InterventionActions.proceed({ reason: `${request.toolName} is read-only` });
    }

    const approved = await this.ask(request);
    if (approved) {
      return InterventionActions.proceed({ reason: 'approved by user' });
    }

    // deny() rather than confirm(): a rejected confirm reaches the model as
    // `CONFIRMATION_FAILED: <prompt>`, which models misread as a system failure
    // and retry. deny() controls the wording, and the SDK turns it into an error
    // tool result that ends up in history as `DENIED: <reason>`.
    return InterventionActions.deny(
      `The user denied permission to run ${request.toolName}. ` +
        `Do not retry it or attempt the same action another way. ` +
        `Tell the user what you wanted to do and ask how to proceed.`,
    );
  }
}

/**
 * Maps a tool call to a permission decision and a renderable summary.
 *
 * Classification is `(toolName, input)`, not name alone: `fileEditor` is a single
 * tool whose `command` spans reading and writing, so the name by itself cannot
 * tell them apart.
 *
 * Unknown tools (including everything from MCP servers) default to `execute`,
 * so a new tool is gated until someone classifies it deliberately.
 */
export function classify(toolName: string, rawInput: unknown): PermissionRequest {
  const input = asRecord(rawInput);

  switch (toolName) {
    case 'bash':
      return classifyBash(toolName, input, rawInput);
    case 'fileEditor':
      return classifyFileEditor(toolName, input, rawInput);
    case 'load_skill':
      return {
        toolName,
        kind: 'read',
        summary: `load_skill: ${str(input['name']) ?? '(unnamed)'}`,
        details: [],
        input: rawInput,
      };
    default:
      return {
        toolName,
        kind: 'execute',
        summary: `${toolName} (unrecognized tool — approval required)`,
        details: [{ label: 'Input', value: pretty(rawInput) }],
        input: rawInput,
      };
  }
}

function classifyBash(toolName: string, input: Record<string, unknown>, rawInput: unknown): PermissionRequest {
  // `restart` only recycles the bash session; it runs no user-supplied command.
  if (input['mode'] === 'restart') {
    return { toolName, kind: 'read', summary: 'bash: restart session', details: [], input: rawInput };
  }

  const command = str(input['command']) ?? '';
  const timeout = input['timeout'];
  const details: PermissionDetail[] = [{ label: 'Command', value: command }];
  if (typeof timeout === 'number') {
    details.push({ label: 'Timeout', value: `${timeout}s` });
  }

  return { toolName, kind: 'execute', summary: `bash: ${firstLine(command)}`, details, input: rawInput };
}

function classifyFileEditor(
  toolName: string,
  input: Record<string, unknown>,
  rawInput: unknown,
): PermissionRequest {
  const command = str(input['command']) ?? '(no command)';
  const filePath = str(input['path']) ?? '(no path)';

  if (command === 'view') {
    return {
      toolName,
      kind: 'read',
      summary: `fileEditor view: ${filePath}`,
      details: [],
      input: rawInput,
    };
  }

  const details: PermissionDetail[] = [
    { label: 'Path', value: filePath },
    { label: 'Operation', value: command },
  ];

  switch (command) {
    case 'create':
      details.push({ label: 'New content', value: str(input['file_text']) ?? '' });
      break;
    case 'str_replace':
      details.push({ label: 'Replace', value: str(input['old_str']) ?? '' });
      // new_str is optional: omitting it deletes the matched text.
      details.push({ label: 'With', value: str(input['new_str']) ?? '(deletes the matched text)' });
      break;
    case 'insert':
      details.push({ label: 'At line', value: String(input['insert_line'] ?? '?') });
      details.push({ label: 'Insert', value: str(input['new_str']) ?? '' });
      break;
    default:
      details.push({ label: 'Input', value: pretty(rawInput) });
  }

  return {
    toolName,
    kind: 'write',
    summary: `fileEditor ${command}: ${filePath}`,
    details,
    input: rawInput,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function firstLine(text: string): string {
  const [line = ''] = text.split('\n');
  return text.includes('\n') ? `${line} …` : line;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

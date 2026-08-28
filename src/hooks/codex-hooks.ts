export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
] as const;

export type CodexHookEventName = (typeof CODEX_HOOK_EVENTS)[number];

export interface CodexHookCommand {
  readonly type: 'command';
  readonly command: string;
  readonly commandWindows?: string;
  readonly timeoutSeconds: number;
  readonly additionalContextBytes: number;
  readonly source: string;
  readonly field: string;
}

export interface CodexHookGroup {
  readonly matcher: RegExp | undefined;
  readonly matcherText: string;
  readonly hooks: readonly CodexHookCommand[];
  readonly source: string;
}

export type CodexHooksConfig = Partial<Record<CodexHookEventName, readonly CodexHookGroup[]>>;

const DEFAULT_TIMEOUT_SECONDS = 600;
const SESSION_END_DEFAULT_TIMEOUT_SECONDS = 1;
export const CODEX_HOOK_TIMEOUT_MAX_SECONDS = 600;
export const CODEX_SESSION_END_TIMEOUT_MAX_SECONDS = 3;
export const CODEX_CONTEXT_MAX_BYTES = 64 * 1024;
const DEFAULT_CONTEXT_BYTES = 10_000;

export function decodeCodexHooks(value: unknown, source: string): CodexHooksConfig {
  const root = record(value, source);
  only(root, ['description', 'hooks'], source);
  if (root['description'] !== undefined && typeof root['description'] !== 'string') {
    fail(`${source}.description`, 'must be a string.');
  }
  const hooks = record(root['hooks'], `${source}.hooks`);
  for (const event of Object.keys(hooks)) {
    if (!CODEX_HOOK_EVENTS.includes(event as CodexHookEventName)) {
      fail(`${source}.hooks.${event}`, `is not supported. Expected ${CODEX_HOOK_EVENTS.join(', ')}.`);
    }
  }

  const result: CodexHooksConfig = {};
  for (const event of CODEX_HOOK_EVENTS) {
    const rawGroups = hooks[event];
    if (rawGroups === undefined) continue;
    if (!Array.isArray(rawGroups)) fail(`${source}.hooks.${event}`, 'must be an array of matcher groups.');
    result[event] = rawGroups.map((rawGroup, groupIndex) => {
      const where = `${source}.hooks.${event}[${groupIndex}]`;
      const group = record(rawGroup, where);
      only(group, ['matcher', 'hooks', 'description'], where);
      if (group['description'] !== undefined && typeof group['description'] !== 'string') {
        fail(`${where}.description`, 'must be a string.');
      }
      const matcherValue = group['matcher'];
      if (matcherValue !== undefined && typeof matcherValue !== 'string') {
        fail(`${where}.matcher`, 'must be a string when present.');
      }
      const matcherText = typeof matcherValue === 'string' ? matcherValue : '';
      let matcher: RegExp | undefined;
      if (matcherText !== '' && matcherText !== '*') {
        try {
          matcher = new RegExp(matcherText);
        } catch (error) {
          fail(`${where}.matcher`, `is not a valid regular expression: ${message(error)}.`);
        }
      }
      const rawHandlers = group['hooks'];
      if (!Array.isArray(rawHandlers) || rawHandlers.length === 0) {
        fail(`${where}.hooks`, 'must be a nonempty array of command hooks.');
      }
      return {
        matcher,
        matcherText,
        source,
        hooks: rawHandlers.map((rawHandler, handlerIndex) =>
          decodeCommand(rawHandler, event, source, `${where}.hooks[${handlerIndex}]`)),
      } satisfies CodexHookGroup;
    });
  }
  return result;
}

function decodeCommand(
  value: unknown,
  event: CodexHookEventName,
  source: string,
  where: string,
): CodexHookCommand {
  const handler = record(value, where);
  only(handler, [
    'type', 'command', 'commandWindows', 'timeout', 'statusMessage',
    'additionalContextLimit', 'async', 'description',
  ], where);
  if (handler['type'] !== 'command') {
    fail(`${where}.type`, 'must be "command"; mcp_tool, prompt, and agent handlers are unsupported.');
  }
  const command = handler['command'];
  if (typeof command !== 'string' || command.trim() === '') fail(`${where}.command`, 'must be a nonblank string.');
  const commandWindows = handler['commandWindows'];
  if (commandWindows !== undefined && (typeof commandWindows !== 'string' || commandWindows.trim() === '')) {
    fail(`${where}.commandWindows`, 'must be a nonblank string when present.');
  }
  if (handler['async'] !== undefined && typeof handler['async'] !== 'boolean') {
    fail(`${where}.async`, 'must be a boolean.');
  }
  if (handler['async'] === true) fail(`${where}.async`, 'background hooks are unsupported; use false or omit it.');
  for (const field of ['statusMessage', 'description'] as const) {
    if (handler[field] !== undefined && typeof handler[field] !== 'string') fail(`${where}.${field}`, 'must be a string.');
  }

  const maximum = event === 'SessionEnd' ? CODEX_SESSION_END_TIMEOUT_MAX_SECONDS : CODEX_HOOK_TIMEOUT_MAX_SECONDS;
  const defaultTimeout = event === 'SessionEnd' ? SESSION_END_DEFAULT_TIMEOUT_SECONDS : DEFAULT_TIMEOUT_SECONDS;
  const timeout = handler['timeout'] ?? defaultTimeout;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > maximum) {
    fail(`${where}.timeout`, `must be a finite number greater than 0 and at most ${maximum} seconds.`);
  }

  const contextLimit = handler['additionalContextLimit'];
  if (contextLimit !== undefined && (
    typeof contextLimit !== 'number' || !Number.isInteger(contextLimit) || contextLimit < 0
  )) {
    fail(`${where}.additionalContextLimit`, 'must be a non-negative integer token limit.');
  }
  const additionalContextBytes = contextLimit === undefined
    ? DEFAULT_CONTEXT_BYTES
    : contextLimit === 0
      ? CODEX_CONTEXT_MAX_BYTES
      : Math.min(CODEX_CONTEXT_MAX_BYTES, safeTokenBytes(contextLimit));

  return {
    type: 'command',
    command,
    ...(typeof commandWindows === 'string' ? { commandWindows } : {}),
    timeoutSeconds: timeout,
    additionalContextBytes,
    source,
    field: where,
  };
}

export function matchesCodexHook(group: CodexHookGroup, values: readonly string[]): boolean {
  return group.matcher === undefined || values.some((value) => {
    group.matcher!.lastIndex = 0;
    return group.matcher!.test(value);
  });
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(where, 'must be an object.');
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${where}.${key}`, `is not supported. Expected ${allowed.join(', ')}.`);
  }
}

function safeTokenBytes(tokens: number): number {
  if (tokens >= Math.ceil(CODEX_CONTEXT_MAX_BYTES / 4)) return CODEX_CONTEXT_MAX_BYTES;
  return tokens * 4;
}

function fail(where: string, reason: string): never {
  throw new Error(`${where} ${reason}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

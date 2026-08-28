import type { ApprovalMode } from '../agent/permission.js';
import type { AppConfig } from '../config.js';
import {
  CODEX_CONTEXT_MAX_BYTES,
  matchesCodexHook,
  type CodexHookCommand,
  type CodexHookEventName,
  type CodexHookGroup,
  type CodexHooksConfig,
} from './codex-hooks.js';
import { HOOK_PAYLOAD_MAX_BYTES, HookProcessManager, type HookProcessResult } from './hook-process.js';

const FIELD_MAX_CODE_POINTS = 8_000;
const REASON_MAX_CODE_POINTS = 1_000;
const MAX_PENDING_PROBLEMS = 16;
const PARENT_CONTEXT_MAX_BYTES = 128 * 1024;

export type CodexSessionStartSource = 'startup' | 'resume' | 'clear';
export type CodexStopOutcome = 'success' | 'failure' | 'cancelled';

export interface CodexPreToolResult {
  readonly allowed: boolean;
  readonly input: unknown;
  readonly reason?: string;
}

export interface CodexPromptResult {
  readonly allowed: boolean;
  readonly context?: string;
  readonly reason?: string;
}

export interface CodexCompactResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface CodexHookRunnerOptions {
  projectRoot: string;
  hooks: CodexHooksConfig;
  sessionId: string;
  config: AppConfig;
  permissionMode: () => ApprovalMode;
  processManager?: HookProcessManager;
  problem?: (message: string) => void;
}

export class CodexHookRunner {
  private readonly processes: HookProcessManager;
  private config: AppConfig;
  private pendingParentContext: string[] = [];
  private problems: string[] = [];
  private droppedProblems = 0;
  private readonly observations = new Set<Promise<void>>();
  private sessionEnded = false;
  private closed = false;

  constructor(private readonly options: CodexHookRunnerOptions) {
    this.processes = options.processManager ?? new HookProcessManager(options.projectRoot);
    this.config = options.config;
  }

  /** Child lifecycle commands need independent cancellation without duplicating policy. */
  fork(): CodexHookRunner {
    return new CodexHookRunner({ ...this.options, config: this.config });
  }

  /** A live `/model` switch changes truthful payload metadata for later events. */
  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  async sessionStart(source: CodexSessionStartSource): Promise<void> {
    const contexts = await this.contextEvent('SessionStart', [source], { source }, true);
    this.stageParent(contexts);
  }

  async userPromptSubmit(prompt: string): Promise<CodexPromptResult> {
    const pending = this.takePendingParentContext();
    const outcome = await this.controllingContextEvent('UserPromptSubmit', [], { prompt: field(prompt) }, true);
    if (!outcome.allowed) {
      this.stageParent(pending);
      return outcome;
    }
    const context = combineContext([...pending, ...(outcome.context === undefined ? [] : [outcome.context])]);
    return { allowed: true, ...(context === undefined ? {} : { context }) };
  }

  async preToolUse(
    event: { toolName: string; toolUseId: string; toolInput: unknown; signal?: AbortSignal },
    groups?: readonly CodexHookGroup[],
  ): Promise<CodexPreToolResult> {
    let input = event.toolInput;
    for (const { group, hook } of this.matching('PreToolUse', toolAliases(event.toolName, input), groups)) {
      const result = await this.run(hook, this.payload('PreToolUse', {
        tool_name: event.toolName,
        tool_use_id: field(event.toolUseId),
        tool_input: boundedJson(input),
      }), event.signal);
      if (result.cancelled) return { allowed: false, input, reason: 'Tool call cancelled during PreToolUse hook.' };
      if (result.timedOut || result.error !== undefined || result.stdoutTruncated || result.stderrTruncated || (result.exitCode !== 0 && result.exitCode !== 2)) {
        return { allowed: false, input, reason: runtimeFailure(hook, result) };
      }
      if (result.exitCode === 2) return { allowed: false, input, reason: reason(result.stderr, 'Blocked by PreToolUse hook.') };
      const decoded = decodeOutput(result.stdout, hook, this.problemSink);
      const control = preToolControl(decoded, hook, this.problemSink);
      if (!control.allowed) return {
        allowed: false,
        input,
        ...(control.reason === undefined ? {} : { reason: control.reason }),
      };
      if (control.input !== undefined) input = control.input;
      // Keep TypeScript aware that source/group identity is intentionally retained by matching().
      void group;
    }
    return { allowed: true, input };
  }

  async postToolUse(
    event: { toolName: string; toolUseId: string; toolInput: unknown; toolResponse: unknown },
    groups?: readonly CodexHookGroup[],
  ): Promise<void> {
    await this.observe('PostToolUse', toolAliases(event.toolName, event.toolInput), {
      tool_name: event.toolName,
      tool_use_id: field(event.toolUseId),
      tool_input: boundedJson(event.toolInput),
      tool_response: boundedJson(event.toolResponse),
    }, true, groups);
  }

  permissionRequest(
    event: { source: string; toolName: string; toolInput: unknown },
    groups?: readonly CodexHookGroup[],
  ): void {
    void this.observe('PermissionRequest', toolAliases(event.toolName, event.toolInput), {
      source: field(event.source),
      tool_name: event.toolName,
      tool_input: boundedJson(event.toolInput),
    }, false, groups);
  }

  async preCompact(trigger: 'manual'): Promise<CodexCompactResult> {
    const outcome = await this.controllingContextEvent('PreCompact', [trigger], { trigger }, false);
    return outcome.allowed ? { allowed: true } : { allowed: false, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) };
  }

  async postCompact(trigger: 'manual'): Promise<void> {
    const contexts = await this.contextEvent('PostCompact', [trigger], { trigger }, false);
    this.stageParent(contexts);
  }

  async subagentStart(agent: { id: string; name: string }): Promise<string | undefined> {
    const contexts = await this.contextEvent('SubagentStart', [agent.name], {
      agent_id: field(agent.id),
      agent_type: field(agent.name),
    }, true);
    return combineContext(contexts);
  }

  subagentStop(agent: { id: string; name: string; outcome: string }): Promise<void> {
    return this.observe('SubagentStop', [agent.name], {
      agent_id: field(agent.id),
      agent_type: field(agent.name),
      outcome: field(agent.outcome),
      stop_hook_active: false,
    }, false);
  }

  stop(outcome: CodexStopOutcome): void {
    void this.observe('Stop', [], { outcome, stop_hook_active: false }, false);
  }

  async sessionEnd(reason = 'other'): Promise<void> {
    if (this.sessionEnded) return;
    this.sessionEnded = true;
    await this.observe('SessionEnd', [reason], { reason }, true);
  }

  takePendingParentContext(): string[] {
    const pending = this.pendingParentContext;
    this.pendingParentContext = [];
    return pending;
  }

  cancel(): void { this.processes.cancel(); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.processes.close();
    await Promise.allSettled([...this.observations]);
  }

  takeProblems(): string[] {
    const problems = this.problems;
    this.problems = [];
    if (this.droppedProblems > 0) {
      problems.push(`${this.droppedProblems} additional hook problem(s) were omitted.`);
      this.droppedProblems = 0;
    }
    return problems;
  }

  private async controllingContextEvent(
    event: CodexHookEventName,
    targets: readonly string[],
    fields: Record<string, unknown>,
    plainContext: boolean,
  ): Promise<CodexPromptResult> {
    const contexts: string[] = [];
    for (const { hook } of this.matching(event, targets)) {
      const payload = this.payload(event, fields);
      if (!payloadFits(payload)) {
        if (event === 'UserPromptSubmit') {
          return { allowed: false, reason: `${event} hook input exceeds the bounded payload limit.` };
        }
        this.problem(`${event} hook input exceeds the bounded payload limit; matching hooks were skipped.`);
        return { allowed: true };
      }
      const result = await this.run(hook, payload);
      if (result.cancelled) return { allowed: false, reason: `${event} hook was cancelled.` };
      if (result.stdoutTruncated || result.stderrTruncated) {
        if (event === 'UserPromptSubmit') return { allowed: false, reason: `${event} hook output exceeded the bounded capture limit.` };
        this.problem(`${event} hook output exceeded the bounded capture limit; output was ignored.`);
        continue;
      }
      if (result.exitCode === 2) return { allowed: false, reason: reason(result.stderr, `${event} hook blocked the operation.`) };
      if (result.timedOut || result.error !== undefined || result.exitCode !== 0) {
        this.problem(runtimeFailure(hook, result));
        continue;
      }
      const decoded = decodeOutput(result.stdout, hook, this.problemSink);
      if (isBlock(decoded)) return { allowed: false, reason: outputReason(decoded!, `${event} hook blocked the operation.`) };
      if (event === 'UserPromptSubmit' && decoded !== undefined && hasUnsupportedPromptControl(decoded)) {
        return { allowed: false, reason: `${hook.field} returned unsupported UserPromptSubmit result control.` };
      }
      reportUnsupportedControls(event, decoded, hook, this.problemSink);
      const context = outputContext(result.stdout, decoded, hook.additionalContextBytes, plainContext);
      if (context !== undefined) contexts.push(context);
    }
    const context = combineContext(contexts);
    return { allowed: true, ...(context === undefined ? {} : { context }) };
  }

  private contextEvent(
    event: CodexHookEventName,
    targets: readonly string[],
    fields: Record<string, unknown>,
    plainContext: boolean,
  ): Promise<string[]> {
    return this.collect(event, targets, fields, plainContext);
  }

  private async collect(
    event: CodexHookEventName,
    targets: readonly string[],
    fields: Record<string, unknown>,
    plainContext: boolean,
  ): Promise<string[]> {
    const contexts: string[] = [];
    for (const { hook } of this.matching(event, targets)) {
      const result = await this.run(hook, this.payload(event, fields));
      if (result.stdoutTruncated || result.stderrTruncated) {
        this.problem(`${event} hook output exceeded the bounded capture limit; context was ignored.`);
        continue;
      }
      if (result.timedOut || result.error !== undefined || result.exitCode !== 0) {
        this.problem(runtimeFailure(hook, result));
        continue;
      }
      const decoded = decodeOutput(result.stdout, hook, this.problemSink);
      reportUnsupportedControls(event, decoded, hook, this.problemSink);
      const context = outputContext(result.stdout, decoded, hook.additionalContextBytes, plainContext);
      if (context !== undefined) contexts.push(context);
    }
    return contexts;
  }

  private async observe(
    event: CodexHookEventName,
    targets: readonly string[],
    fields: Record<string, unknown>,
    awaitCompletion: boolean,
    groups?: readonly CodexHookGroup[],
  ): Promise<void> {
    const operation = async (): Promise<void> => {
      for (const { hook } of this.matching(event, targets, groups)) {
        const result = await this.run(hook, this.payload(event, fields));
        if (result.stdoutTruncated || result.stderrTruncated) {
          this.problem(`${event} hook output exceeded the bounded capture limit; output was ignored.`);
        } else if (result.timedOut || result.error !== undefined || result.exitCode !== 0) {
          this.problem(runtimeFailure(hook, result));
        } else {
          reportUnsupportedControls(event, decodeOutput(result.stdout, hook, this.problemSink), hook, this.problemSink);
        }
      }
    };
    if (awaitCompletion) await operation();
    else {
      const observation = operation().finally(() => this.observations.delete(observation));
      this.observations.add(observation);
      void observation.catch(() => undefined);
    }
  }

  private matching(
    event: CodexHookEventName,
    targets: readonly string[],
    groups: readonly CodexHookGroup[] = this.options.hooks[event] ?? [],
  ): { group: CodexHookGroup; hook: CodexHookCommand }[] {
    const ignoreMatcher = event === 'UserPromptSubmit' || event === 'Stop';
    return groups.flatMap((group) =>
      (ignoreMatcher || matchesCodexHook(group, targets))
        ? group.hooks.map((hook) => ({ group, hook }))
        : []);
  }

  private payload(event: CodexHookEventName, fields: Record<string, unknown>): Record<string, unknown> {
    const permissionMode = codexPermissionMode(this.options.permissionMode());
    return {
      session_id: this.options.sessionId,
      cwd: this.options.projectRoot,
      hook_event_name: event,
      model: this.config.model,
      ...(permissionMode === undefined ? {} : { permission_mode: permissionMode }),
      ...fields,
    };
  }

  private run(
    hook: CodexHookCommand,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HookProcessResult> {
    return this.processes.run(hook.command, hook.commandWindows, payload, hook.timeoutSeconds * 1000, signal);
  }

  private stageParent(contexts: readonly string[]): void {
    for (const context of contexts) {
      const combined = combineContext([...this.pendingParentContext, context], PARENT_CONTEXT_MAX_BYTES);
      this.pendingParentContext = combined === undefined ? [] : [combined];
    }
  }

  private readonly problemSink = (message: string): void => this.problem(message);

  private problem(message: string): void {
    if (this.closed) return;
    const bounded = reason(message, 'Hook problem.');
    // Runtime hook failures are advisory diagnostics. They must never bypass
    // Ink or the structured-headless protocol through raw process stderr.
    if (this.problems.length < MAX_PENDING_PROBLEMS) this.problems.push(bounded);
    else this.droppedProblems += 1;
    this.options.problem?.(bounded);
  }
}

export function injectCodexContext(text: string, context: string | undefined): string {
  if (context === undefined || context.trim() === '') return text;
  return `<hook-context>\n${context}\n</hook-context>\n\n${text}`;
}

function outputContext(stdout: string, decoded: Record<string, unknown> | undefined, limit: number, plain: boolean): string | undefined {
  let context: unknown;
  if (decoded === undefined) context = plain && !looksLikeJson(stdout) ? stdout.trim() : undefined;
  else {
    const specific = object(decoded['hookSpecificOutput']);
    context = specific?.['additionalContext'] ?? decoded['additionalContext'];
  }
  if (typeof context !== 'string' || context.trim() === '') return undefined;
  return truncateUtf8(context.trim(), Math.min(limit, CODEX_CONTEXT_MAX_BYTES));
}

function preToolControl(
  output: Record<string, unknown> | undefined,
  hook: CodexHookCommand,
  problem: ((message: string) => void) | undefined,
): { allowed: boolean; reason?: string; input?: unknown } {
  if (output === undefined) return { allowed: true };
  const specific = object(output['hookSpecificOutput']);
  const legacyDecision = output['decision'];
  const decision = specific?.['permissionDecision'];
  if (output['continue'] === false || output['stopReason'] !== undefined || output['suppressOutput'] !== undefined) {
    return { allowed: false, reason: `${hook.field} returned unsupported PreToolUse result control.` };
  }
  if (legacyDecision === 'block' || decision === 'deny') {
    return { allowed: false, reason: outputReason(output, 'Blocked by PreToolUse hook.') };
  }
  if (legacyDecision !== undefined || (decision !== undefined && decision !== 'allow')) {
    return { allowed: false, reason: `${hook.field} returned an unsupported PreToolUse decision.` };
  }
  const updatedInput = specific?.['updatedInput'];
  if (decision === 'allow' && updatedInput === undefined) {
    return { allowed: false, reason: `${hook.field} returned permissionDecision "allow" without updatedInput; Darwin hooks cannot auto-approve tools.` };
  }
  if (updatedInput !== undefined) {
    if (decision !== 'allow' || object(updatedInput) === undefined) {
      return { allowed: false, reason: `${hook.field} returned invalid updatedInput; it requires permissionDecision "allow" and an object.` };
    }
    return { allowed: true, input: updatedInput };
  }
  reportUnsupportedControls('PreToolUse', output, hook, problem);
  return { allowed: true };
}

function reportUnsupportedControls(
  event: CodexHookEventName,
  output: Record<string, unknown> | undefined,
  hook: CodexHookCommand,
  problem: ((message: string) => void) | undefined,
): void {
  if (output === undefined) return;
  const specific = object(output['hookSpecificOutput']);
  const controlling = output['decision'] !== undefined || output['continue'] === false || output['stopReason'] !== undefined ||
    output['suppressOutput'] !== undefined || specific?.['decision'] !== undefined || specific?.['updatedMCPToolOutput'] !== undefined ||
    specific?.['permissionDecision'] !== undefined || specific?.['updatedInput'] !== undefined;
  if (controlling && !['UserPromptSubmit', 'PreCompact', 'PreToolUse'].includes(event)) {
    problem?.(`${hook.field} requested unsupported ${event} result control; Darwin kept the owning result/permission/outcome unchanged.`);
  }
}

function decodeOutput(
  stdout: string,
  hook: CodexHookCommand,
  problem: ((message: string) => void) | undefined,
): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (trimmed === '' || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const decoded = object(parsed);
    if (decoded === undefined) problem?.(`${hook.field} returned JSON that was not an object; output was ignored.`);
    return decoded;
  } catch (error) {
    problem?.(`${hook.field} returned invalid JSON; output was ignored: ${error instanceof Error ? error.message : String(error)}.`);
    return undefined;
  }
}


function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function isBlock(output: Record<string, unknown> | undefined): boolean {
  return output?.['decision'] === 'block' || output?.['continue'] === false;
}

function hasUnsupportedPromptControl(output: Record<string, unknown>): boolean {
  return output['decision'] !== undefined || output['stopReason'] !== undefined || output['suppressOutput'] !== undefined;
}

function outputReason(output: Record<string, unknown>, fallback: string): string {
  const specific = object(output['hookSpecificOutput']);
  const value = specific?.['permissionDecisionReason'] ?? output['reason'] ?? output['stopReason'];
  return typeof value === 'string' && value.trim() !== '' ? reason(value, fallback) : fallback;
}

function runtimeFailure(hook: CodexHookCommand, result: HookProcessResult): string {
  if (result.cancelled) return `${hook.field} was cancelled.`;
  if (result.stdoutTruncated || result.stderrTruncated) return `${hook.field} output exceeded the bounded capture limit.`;
  if (result.timedOut) return `${hook.field} timed out after ${hook.timeoutSeconds} seconds.`;
  if (result.error !== undefined) return `${hook.field} could not launch: ${result.error.message}.`;
  const detail = result.stderr.trim();
  return `${hook.field} failed with exit code ${String(result.exitCode)}${detail === '' ? '.' : `: ${reason(detail, 'hook failure')}`}`;
}

function toolAliases(toolName: string, input: unknown): string[] {
  const aliases = [toolName];
  if (toolName === 'bash') aliases.push('Bash');
  if (toolName === 'fileEditor') {
    const command = object(input)?.['command'];
    if (command === 'create' || command === 'str_replace' || command === 'insert') aliases.push('apply_patch', 'Edit', 'Write');
  }
  if (toolName === 'subagent') aliases.push('Agent');
  return aliases;
}

function boundedJson(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    if (text.length <= FIELD_MAX_CODE_POINTS) return value;
    return { truncated: true, preview: field(text) };
  } catch {
    return { unavailable: true };
  }
}

function field(value: string): string {
  const points = [...value];
  return points.length <= FIELD_MAX_CODE_POINTS ? value : `${points.slice(0, FIELD_MAX_CODE_POINTS - 1).join('')}…`;
}

function reason(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized === '') return fallback;
  const points = [...normalized];
  return points.length <= REASON_MAX_CODE_POINTS ? normalized : `${points.slice(0, REASON_MAX_CODE_POINTS - 1).join('')}…`;
}

function combineContext(contexts: readonly string[], maximum = PARENT_CONTEXT_MAX_BYTES): string | undefined {
  const clean = contexts.map((value) => value.trim()).filter(Boolean);
  if (clean.length === 0) return undefined;
  return truncateUtf8(clean.join('\n\n'), maximum);
}

function truncateUtf8(value: string, maximum: number): string {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maximum) return value;
  const notice = `\n… hook context truncated from ${bytes} bytes`;
  const budget = Math.max(0, maximum - Buffer.byteLength(notice, 'utf8'));
  let result = '';
  let used = 0;
  for (const point of value) {
    const size = Buffer.byteLength(point, 'utf8');
    if (used + size > budget) break;
    result += point;
    used += size;
  }
  return `${result}${notice}`;
}

function payloadFits(payload: Record<string, unknown>): boolean {
  try {
    return Buffer.byteLength(`${JSON.stringify(payload)}\n`, 'utf8') <= HOOK_PAYLOAD_MAX_BYTES;
  } catch {
    return false;
  }
}


function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function codexPermissionMode(mode: ApprovalMode): string | undefined {
  if (mode === 'default' || mode === 'plan') return mode;
  if (mode === 'yolo') return 'bypassPermissions';
  return undefined;
}

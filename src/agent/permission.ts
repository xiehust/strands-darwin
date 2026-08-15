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
import path from 'node:path';

import { sensitiveDarwinPaths } from '../paths.js';

import { InterventionActions, InterventionHandler } from '@strands-agents/sdk';
import type { BeforeToolCallEvent } from '@strands-agents/sdk';

import {
  hasShellMetacharacters,
  matchesAnyRule,
  splitBashSegments,
  suggestRules,
  type RuleSuggestion,
} from './permission-rules.js';

/**
 * The `InterventionAction` union is not re-exported from the package root and
 * `./interventions` has no subpath export, so derive it from the base class.
 */
type InterventionAction = Awaited<ReturnType<InterventionHandler['beforeToolCall']>>;

/** How a tool call is classified. `read` calls run without asking. */
export type PermissionKind = 'read' | 'write' | 'execute';

/**
 * How much confirmation the gate demands.
 *
 * - `default`: statically safe calls run silently; everything else asks.
 * - `auto`: like `default`, but calls the static rules cannot clear are judged
 *   by a model classifier first; only classifier-flagged calls ask.
 * - `yolo`: everything runs without asking.
 */
export type ApprovalMode = 'default' | 'auto' | 'yolo';

export const APPROVAL_MODES = ['default', 'auto', 'yolo'] as const satisfies readonly ApprovalMode[];

/**
 * Whether a call is *provably* safe. `dangerous` means "not on the safe list",
 * not "known harmful": the rules only whitelist, so a parsing miss can cost an
 * extra prompt but never a silent approval.
 */
export type PermissionRisk = 'safe' | 'dangerous';

export interface RiskAssessment {
  risk: PermissionRisk;
  /** Human-readable, shown in the confirmation prompt. */
  riskReason: string;
}

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
 * A {@link PermissionRequest} with its risk assessment and the "always allow"
 * offers derived from it — what bridges see.
 */
export interface AssessedPermissionRequest extends PermissionRequest, RiskAssessment {
  /**
   * Wildcard rules the user may accept alongside this one call, most specific
   * first. Empty when no rule could ever cover the call.
   */
  suggestions: readonly RuleSuggestion[];
}

/** What the human answered: allow or not, and any rule to remember. */
export interface PermissionDecision {
  allowed: boolean;
  /**
   * A rule from `request.suggestions` the user chose. The gate applies it to the
   * rest of the session; persisting it is the caller's business, so a failed
   * write costs the file, not the session.
   */
  rule?: string;
}

/**
 * Asks the human to approve one tool call.
 *
 * Implementations may block for as long as they need — the SDK awaits
 * intervention callbacks serially, so the agent loop waits.
 */
export type PermissionBridge = (request: AssessedPermissionRequest) => Promise<PermissionDecision>;

/** Approves everything without asking. For non-interactive runs and tests. */
export const allowAllBridge: PermissionBridge = async () => ({ allowed: true });


/** The classifier's judgement of one call, in `auto` mode. */
export interface SafetyVerdict {
  safe: boolean;
  reason: string;
}

/**
 * Judges a call the static rules could not clear. May call a model; the gate
 * bounds it with a timeout and treats any failure as "not safe".
 */
export type SafetyClassifier = (request: AssessedPermissionRequest) => Promise<SafetyVerdict>;

export interface PermissionGateOptions {
  mode: ApprovalMode;
  /** Root the static path-containment rules resolve against. */
  projectRoot: string;
  ask: PermissionBridge;
  /** Wildcard allow-rules from the config; see `./permission-rules.ts`. */
  allowRules?: readonly string[];
  /** Consulted for dangerous calls in `auto` mode; ignored otherwise. */
  classifier?: SafetyClassifier;
  /** How long `auto` waits for the classifier before falling back to asking. */
  classifierTimeoutMs?: number;
}

const DEFAULT_CLASSIFIER_TIMEOUT_MS = 5000;

export class PermissionGate extends InterventionHandler {
  readonly name = 'darwin:permission-gate';

  /** Config rules plus anything the user accepted during this session. */
  private readonly rules: string[];

  constructor(private readonly options: PermissionGateOptions) {
    super();
    this.rules = [...(options.allowRules ?? [])];
  }

  /**
   * Starts honouring a rule immediately. Separate from persistence on purpose: a
   * rule the user just accepted must hold for the rest of the session even if
   * writing it to the config fails.
   */
  addAllowRule(rule: string): void {
    if (!this.rules.includes(rule)) this.rules.push(rule);
  }

  /** Rules currently in effect, config and session alike. */
  get allowRules(): readonly string[] {
    return this.rules;
  }

  override async beforeToolCall(event: BeforeToolCallEvent): Promise<InterventionAction> {
    const base = classify(event.toolUse.name, event.toolUse.input);
    const request: AssessedPermissionRequest = {
      ...base,
      ...assessRisk(base, this.options.projectRoot),
      suggestions: suggestRules(base, this.options.projectRoot),
    };

    if (this.options.mode === 'yolo') {
      return InterventionActions.proceed({ reason: 'yolo mode approves everything' });
    }

    if (request.risk === 'safe') {
      return InterventionActions.proceed({ reason: request.riskReason });
    }

    // Before the classifier, not after: a rule the user wrote down should save the
    // model call too, not just the prompt.
    const matched = matchesAnyRule(this.rules, base, this.options.projectRoot);
    if (matched !== undefined) {
      return InterventionActions.proceed({ reason: `allowed by rule ${matched}` });
    }

    if (this.options.mode === 'auto') {
      const verdict = await this.classifierVerdict(request);
      if (verdict.safe) {
        return InterventionActions.proceed({ reason: `classifier: ${verdict.reason}` });
      }
      // Escalating to the human: show them why the classifier balked. The details
      // array is our own copy (classify builds a fresh one per call), so pushing
      // here cannot leak into other renders of the same tool call.
      request.details.push({ label: 'Classifier', value: verdict.reason });
    }

    const decision = await this.options.ask(request);
    if (decision.allowed) {
      // Only on approval: a rule attached to a refusal would be a contradiction.
      if (decision.rule !== undefined) this.addAllowRule(decision.rule);
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

  /**
   * Runs the classifier with a hard timeout. Every failure mode — missing
   * classifier, throw, timeout, or a hung promise — collapses to "not safe", so
   * degradation always lands on asking the user, never on silent approval.
   */
  private async classifierVerdict(request: AssessedPermissionRequest): Promise<SafetyVerdict> {
    const { classifier, classifierTimeoutMs = DEFAULT_CLASSIFIER_TIMEOUT_MS } = this.options;
    if (classifier === undefined) {
      return { safe: false, reason: 'no classifier configured — asking user' };
    }
    try {
      return await withTimeout(classifier(request), classifierTimeoutMs);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return { safe: false, reason: `classifier unavailable (${cause}) — asking user` };
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
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
    case 'subagent':
      return {
        toolName,
        kind: 'read',
        summary: `subagent: ${str(input['agent']) ?? 'general'}`,
        details: [{ label: 'Task', value: str(input['task']) ?? '(missing task)' }],
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
  const mode = str(input['mode']);
  // Lifecycle operations observe or reduce only manager/session-owned work. They
  // run no new user-supplied command and are therefore statically safe.
  if (mode === 'restart') {
    return { toolName, kind: 'read', summary: 'bash: restart session', details: [], input: rawInput };
  }
  if (mode === 'list') {
    return { toolName, kind: 'read', summary: 'bash: list background tasks', details: [], input: rawInput };
  }
  if (mode === 'status' || mode === 'output' || mode === 'stop') {
    return {
      toolName,
      kind: 'read',
      summary: `bash ${mode}: ${str(input['taskId']) ?? '(missing task id)'}`,
      details: [],
      input: rawInput,
    };
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

/**
 * Commands whose first word makes a bash segment provably read-only. `git` is
 * handled separately because only some subcommands qualify.
 */
const SAFE_BASH_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'rg',
  'find',
  'pwd',
  'which',
  'wc',
  'echo',
]);

const SAFE_GIT_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch']);

/** Sensitive file basenames a write must never touch silently. */
const ENV_FILE = /^\.env(\..+)?$/;

/**
 * The static safety rules shared by `default` and `auto`. Whitelist only: a
 * call is `safe` when the rules can *prove* it harmless, `dangerous` otherwise
 * — including every unknown and MCP tool.
 */
export function assessRisk(request: PermissionRequest, projectRoot: string): RiskAssessment {
  if (request.kind === 'read') {
    return { risk: 'safe', riskReason: `${request.toolName} is read-only` };
  }

  const input = asRecord(request.input);

  if (request.toolName === 'bash') {
    return assessBashRisk(str(input['command']) ?? '');
  }

  if (request.toolName === 'fileEditor') {
    return assessWriteRisk(str(input['path']) ?? '', projectRoot);
  }

  return { risk: 'dangerous', riskReason: 'unrecognized tool — cannot be classified as safe' };
}

function assessBashRisk(command: string): RiskAssessment {
  if (hasShellMetacharacters(command)) {
    return { risk: 'dangerous', riskReason: 'command uses redirection or substitution' };
  }

  // Only safe when every chained segment is: see splitBashSegments.
  const segments = splitBashSegments(command);

  if (segments.length === 0) {
    return { risk: 'dangerous', riskReason: 'empty command' };
  }

  for (const segment of segments) {
    const [word = '', subcommand = ''] = segment.split(/\s+/);
    if (word === 'git') {
      if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
        return { risk: 'dangerous', riskReason: `\`git ${subcommand}\` is not a read-only git command` };
      }
    } else if (!SAFE_BASH_COMMANDS.has(word)) {
      return { risk: 'dangerous', riskReason: `\`${word}\` is not on the safe-command list` };
    }
  }

  return { risk: 'safe', riskReason: 'read-only command' };
}

function assessWriteRisk(filePath: string, projectRoot: string): RiskAssessment {
  const resolved = path.resolve(projectRoot, filePath);
  const relative = path.relative(projectRoot, resolved);

  if (sensitiveDarwinPaths(projectRoot).includes(resolved)) {
    return { risk: 'dangerous', riskReason: "path is darwin's own configuration" };
  }
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { risk: 'dangerous', riskReason: 'path is outside the project' };
  }

  const segments = relative.split(path.sep);
  if (segments.includes('.git')) {
    return { risk: 'dangerous', riskReason: 'path touches .git internals' };
  }
  if (ENV_FILE.test(path.basename(resolved))) {
    return { risk: 'dangerous', riskReason: 'path is an environment file' };
  }
  // The agent must not silently rewrite its own permission mode.
  if (relative === path.join('.darwin', 'config.json')) {
    return { risk: 'dangerous', riskReason: "path is darwin's own configuration" };
  }

  return { risk: 'safe', riskReason: 'write inside the project' };
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

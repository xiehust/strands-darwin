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

import { isSensitiveDarwinPath } from '../paths.js';

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
 * - `plan`: reads run; writes and executes are denied without escalation.
 * - `yolo`: everything runs without asking.
 */
export type ApprovalMode = 'default' | 'auto' | 'plan' | 'yolo';

export const APPROVAL_MODES = ['default', 'auto', 'plan', 'yolo'] as const satisfies readonly ApprovalMode[];

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value);
}

/**
 * One clause per mode, for a notice that has to say what the mode the user just
 * typed actually does. The header words the same three states itself, because it
 * has one row to spend and a notice does not.
 */
export function describeApprovalMode(mode: ApprovalMode): string {
  switch (mode) {
    case 'default':
      return 'default — statically safe calls run silently; everything else asks';
    case 'auto':
      return 'auto — a model classifier judges what the static rules cannot clear; only flagged calls ask';
    case 'plan':
      return 'plan — read-only; write and execute calls are denied';
    case 'yolo':
      return 'yolo — every tool call runs without confirmation';
  }
}

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
  /**
   * Marks a block whose value is raw edit content (`file_text`, `old_str`,
   * `new_str`). A presenting UI may substitute exactly these blocks with a line
   * diff computed from `PermissionRequest.input` — the same strings, one
   * projection — and must keep every unmarked block stated. Renderers that do
   * not diff (dev-repl) ignore the flag and keep the raw blocks.
   */
  editContent?: boolean;
}

/**
 * Which agent a request came from.
 *
 * Parent and every child share one gate instance (that is what keeps allow-rules
 * and the live bridge coherent), and children run concurrently — so without this
 * a prompt cannot say whose work it is about. `label` is bounded and ready to
 * render: a permission box shares the live frame with the header, so provenance
 * has to ride an existing line rather than earn one.
 */
export interface PermissionSource {
  /** `parent` is the one assembled agent; `child` is a tracked dispatch. */
  kind: 'parent' | 'child';
  /** `parent`, or `<agent>#<dispatchId>`. */
  label: string;
  /** Child only: which dispatch asked. */
  dispatchId?: string;
  /** Child only: the dispatched definition name. */
  agentName?: string;
}

/**
 * The one source every non-delegated call carries. Frozen because it is shared by
 * every parent request: a consumer that mutated it would relabel all of them.
 */
export const PARENT_PERMISSION_SOURCE: PermissionSource = Object.freeze({
  kind: 'parent',
  label: 'parent',
});

/**
 * Resolves a child `Agent.id` to its dispatch, or `undefined` when the id is not
 * a tracked dispatch — which in darwin means the parent, because the runtime
 * builds exactly one `Agent` plus the children the dispatch registry records.
 *
 * Deliberately a narrow function rather than the registry type: the permission
 * layer must not depend on the delegation tool to know who is asking.
 */
export type DispatchSourceResolver = (
  agentId: string,
) => { dispatchId: string; agentName: string; label: string } | undefined;

/**
 * A {@link PermissionRequest} with its risk assessment, its origin, and the
 * "always allow" offers derived from it — what bridges see.
 */
export interface AssessedPermissionRequest extends PermissionRequest, RiskAssessment {
  /** Which agent this call belongs to. Always present, parent calls included. */
  source: PermissionSource;
  /**
   * Wildcard rules the user may accept alongside this one call, most specific
   * first. Empty when no rule could ever cover the call.
   */
  suggestions: readonly RuleSuggestion[];
  /**
   * Aborts when the user changes the permission mode while this request is
   * pending — the one case where the question on screen was asked under a policy
   * that is no longer in force.
   *
   * A bridge that shows a prompt **must** drop it when this fires: the gate has
   * stopped waiting and will re-decide the whole call under the new mode, so an
   * answer arriving afterwards is discarded rather than applied. A bridge that
   * ignores the signal is not unsafe (the answer is still discarded), it merely
   * leaves a stale question on screen.
   */
  withdrawn: AbortSignal;
}

/**
 * A signal that never aborts, for the bridges and fixtures that construct a
 * request themselves. Frozen into one instance on purpose: an
 * {@link AbortController} per fixture would suggest withdrawal is in play there.
 */
export const NEVER_WITHDRAWN: AbortSignal = new AbortController().signal;

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
  /** Where enforcement starts. `PermissionGate.setMode` moves it, user-only. */
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
  /**
   * Labels a call with the child dispatch it came from. Omitted means every call
   * reads as the parent's, which is only true for a runtime with no delegation.
   */
  dispatchSource?: DispatchSourceResolver;
}

const DEFAULT_CLASSIFIER_TIMEOUT_MS = 5000;

/**
 * How many times one tool call may be re-decided because the mode changed under
 * it. Every restart costs the user a deliberate keystroke, so this is unreachable
 * in practice; it exists so the loop is bounded by construction rather than by
 * an argument about human behaviour. Reaching it denies — the fail-closed
 * direction — and says why.
 */
const MAX_MODE_CHANGE_RESTARTS = 16;

/** A decision abandoned because the mode changed while it was pending. */
const WITHDRAWN = Symbol('withdrawn');

/**
 * Where a live allow-rule came from. `configured` means it was loaded from the
 * project's `permission-rules.json` at startup; `session` means the user granted
 * it in a confirmation prompt during this session. A configured rule that is
 * revoked and later re-granted reads as `session`, because that is when the
 * authority it carries was actually given.
 */
export type AllowRuleOrigin = 'configured' | 'session';

/** One live allow-rule with its provenance, for the `/permissions` report. */
export interface AllowRuleEntry {
  rule: string;
  origin: AllowRuleOrigin;
}

/** What a mode change did, for the notice that reports it. */
export interface PermissionModeChange {
  /** The mode now in force. */
  mode: ApprovalMode;
  previous: ApprovalMode;
  /**
   * Pending tool decisions withdrawn by the change — a classifier call in flight
   * or a prompt waiting for an answer. Each is re-decided from the top under
   * {@link mode}; none is resolved under {@link previous}.
   */
  withdrawn: number;
}

export class PermissionGate extends InterventionHandler {
  readonly name = 'darwin:permission-gate';

  /** Config rules plus anything the user accepted during this session. */
  private readonly rules: string[];

  /**
   * Provenance of every rule in {@link rules}, keyed by the rule string. Kept as
   * a side table rather than widening `rules` because the decision path
   * (`matchesAnyRule`) reads the plain strings and must stay unchanged.
   */
  private readonly ruleOrigins = new Map<string, AllowRuleOrigin>();

  /**
   * Live enforcement policy, not `options.mode`: `/mode` moves it mid-session and
   * every decision — parent and child, since they share this instance — reads it
   * from here.
   */
  private currentMode: ApprovalMode;

  /**
   * One controller per in-flight decision that is waiting on something external
   * (a classifier verdict, or the user's answer). {@link setMode} aborts them all.
   */
  private readonly waiting = new Set<AbortController>();

  constructor(private readonly options: PermissionGateOptions) {
    super();
    this.rules = [...(options.allowRules ?? [])];
    for (const rule of this.rules) this.ruleOrigins.set(rule, 'configured');
    this.currentMode = options.mode;
  }

  /** The mode enforcing right now. */
  get mode(): ApprovalMode {
    return this.currentMode;
  }

  /**
   * Switches the mode for the rest of the session. **User-only**: nothing the
   * model can emit reaches this — no tool mutates the gate, the value is never
   * read back from a file after startup, and the two callers (the TUI's submit
   * handler and the dev REPL's input loop) are fed by the keyboard alone.
   *
   * Every decision still pending is *withdrawn* rather than resolved: a
   * classifier verdict answers a question only `auto` asks, and a prompt on screen
   * was worded under the previous policy. The gate re-decides each of those calls
   * from the top under the new mode, so no call is ever half-judged by two modes.
   * One rule for every transition on purpose — the alternative is a table of which
   * transitions are benign, and that table is where the bug would live.
   *
   * Deliberately not persisted: this changes *enforcement*, and a widening that
   * outlives the session is exactly what the allow-rule exemptions exist to
   * prevent (`./permission-rules.ts`).
   */
  setMode(next: ApprovalMode): PermissionModeChange {
    const previous = this.currentMode;
    if (next === previous) return { mode: previous, previous, withdrawn: 0 };

    this.currentMode = next;
    // Copied before aborting: a bridge that drops its prompt synchronously lets
    // the awaiting decision remove itself from this set as we iterate it.
    const waiting = [...this.waiting];
    for (const controller of waiting) controller.abort();
    return { mode: next, previous, withdrawn: waiting.length };
  }

  /**
   * Starts honouring a rule immediately. Separate from persistence on purpose: a
   * rule the user just accepted must hold for the rest of the session even if
   * writing it to the config fails.
   */
  addAllowRule(rule: string): void {
    if (this.rules.includes(rule)) return;
    this.rules.push(rule);
    this.ruleOrigins.set(rule, 'session');
  }

  /**
   * Stops honouring a rule immediately: the very next matching call goes back
   * through the ordinary decision path and prompts. Removal-only by construction
   * — this is the narrowing half of the rule lifecycle, and there is nothing it
   * can add. Returns whether the rule was live, so the caller can refuse to
   * "revoke" (and persist the removal of) a rule that was never in force.
   */
  removeAllowRule(rule: string): boolean {
    const index = this.rules.indexOf(rule);
    if (index === -1) return false;
    this.rules.splice(index, 1);
    this.ruleOrigins.delete(rule);
    return true;
  }

  /** Rules currently in effect, config and session alike. */
  get allowRules(): readonly string[] {
    return this.rules;
  }

  /**
   * The live rules with their provenance, in the order they are consulted.
   * A fresh array per call: the report must not hand out a mutable window onto
   * the enforcement surface.
   */
  listAllowRules(): AllowRuleEntry[] {
    return this.rules.map((rule) => ({ rule, origin: this.ruleOrigins.get(rule) ?? 'session' }));
  }

  /**
   * Denies plan-mode mutation before hooks, rules, classifiers, or prompts can
   * have side effects. Undefined means the ordinary permission flow still owns
   * the call; callers must not treat it as approval.
   *
   * Reads the live mode, so entering plan mid-session guards the very next call
   * and leaving it stops guarding immediately.
   */
  planGuard(toolName: string, input: unknown): InterventionAction | undefined {
    if (this.currentMode !== 'plan') return undefined;
    const request = classify(toolName, input);
    if (request.kind === 'read') return undefined;
    return InterventionActions.deny(
      `Plan mode blocked this ${request.kind} call to ${request.toolName}. ` +
        `Continue with read-only inspection, or ask the user to run outside plan mode ` +
        `(they can leave it with /mode default) before changing or executing anything.`,
    );
  }

  /**
   * Decides one call, restarting whenever the user changes the mode underneath it.
   *
   * The loop is the whole in-flight contract: a withdrawn decision is discarded,
   * never applied, and the call is judged again from the top — plan guard first —
   * by whatever mode is in force now.
   */
  override async beforeToolCall(event: BeforeToolCallEvent): Promise<InterventionAction> {
    for (let attempt = 1; ; attempt += 1) {
      const withdrawal = new AbortController();
      this.waiting.add(withdrawal);
      let action: InterventionAction | typeof WITHDRAWN;
      try {
        action = await this.decideOnce(event, withdrawal.signal);
      } finally {
        this.waiting.delete(withdrawal);
      }
      if (action !== WITHDRAWN) return action;

      if (attempt >= MAX_MODE_CHANGE_RESTARTS) {
        return InterventionActions.deny(
          `The permission mode changed ${attempt} times while ${event.toolUse.name} was waiting for a decision, ` +
            `so darwin stopped re-asking. Tell the user, and try again once they have settled on a mode.`,
        );
      }
    }
  }

  /**
   * One pass of the decision, under the mode in force when it started.
   *
   * Returns {@link WITHDRAWN} instead of a decision when the mode changed while
   * this pass was waiting on the classifier or on the user — including the case
   * where the answer and the change land in the same tick, which is why the race
   * re-checks `aborted` after the promise settles.
   */
  private async decideOnce(
    event: BeforeToolCallEvent,
    withdrawn: AbortSignal,
  ): Promise<InterventionAction | typeof WITHDRAWN> {
    const guarded = this.planGuard(event.toolUse.name, event.toolUse.input);
    if (guarded !== undefined) return guarded;

    const base = classify(event.toolUse.name, event.toolUse.input);
    const request: AssessedPermissionRequest = {
      ...base,
      ...assessRisk(base, this.options.projectRoot),
      // Resolved for every call, not only the ones that prompt: a classifier or a
      // bridge that wants to know whose work it is judging should not have to
      // reconstruct it from the tool input.
      source: this.sourceOf(event.agent.id),
      suggestions: suggestRules(base, this.options.projectRoot),
      withdrawn,
    };

    if (this.currentMode === 'yolo') {
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

    if (this.currentMode === 'auto') {
      const verdict = await raceWithdrawal(this.classifierVerdict(request), withdrawn);
      // The verdict answers "may auto mode skip the prompt", so a mode change
      // makes it moot — discarded, exactly as the peer product documents.
      if (verdict === WITHDRAWN) return WITHDRAWN;
      if (verdict.safe) {
        return InterventionActions.proceed({ reason: `classifier: ${verdict.reason}` });
      }
      // Escalating to the human: show them why the classifier balked. The details
      // array is our own copy (classify builds a fresh one per call), so pushing
      // here cannot leak into other renders of the same tool call.
      request.details.push({ label: 'Classifier', value: verdict.reason });
    }

    const decision = await raceWithdrawal(this.options.ask(request), withdrawn);
    if (decision === WITHDRAWN) return WITHDRAWN;
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
   * Who is asking. A tracked dispatch resolves to its child label; anything else
   * is the parent, because the runtime assembles exactly one `Agent` and every
   * other agent in the process is a dispatch this resolver knows about.
   */
  private sourceOf(agentId: string): PermissionSource {
    const dispatch = this.options.dispatchSource?.(agentId);
    if (dispatch === undefined) return PARENT_PERMISSION_SOURCE;
    return {
      kind: 'child',
      label: dispatch.label,
      dispatchId: dispatch.dispatchId,
      agentName: dispatch.agentName,
    };
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

/**
 * Resolves with {@link WITHDRAWN} as soon as the mode changes, and — the part that
 * matters — also when the promise settles in the same tick as the change. A
 * decision taken under a mode that is no longer in force is never applied, so the
 * check happens after the settle, not only before the wait.
 *
 * A rejection still propagates: an `ask` that throws is a bridge failure, not a
 * withdrawal, and the gate's callers have always seen it.
 */
function raceWithdrawal<T>(promise: Promise<T>, withdrawn: AbortSignal): Promise<T | typeof WITHDRAWN> {
  if (withdrawn.aborted) return Promise.resolve(WITHDRAWN);
  return new Promise<T | typeof WITHDRAWN>((resolve, reject) => {
    const onAbort = (): void => resolve(WITHDRAWN);
    withdrawn.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        withdrawn.removeEventListener('abort', onAbort);
        resolve(withdrawn.aborted ? WITHDRAWN : value);
      },
      (error: unknown) => {
        withdrawn.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
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
    case 'imageViewer':
      return {
        toolName,
        kind: 'read',
        summary: `imageViewer: ${firstLine(str(input['path']) ?? '(missing path)')}`,
        details: [],
        input: rawInput,
      };
    // The context offloader's own retrieval tool: it reads back a tool result
    // this session already produced and stored. Unknown tools fail closed as
    // `execute`, which would make every retrieval prompt the user for something
    // they already approved once.
    case 'retrieve_offloaded_content':
      return {
        toolName,
        kind: 'read',
        summary: `retrieve_offloaded_content: ${str(input['reference']) ?? '(no reference)'}`,
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
    case 'update_plan':
      return {
        toolName,
        kind: 'read',
        summary: 'update_plan: replace progress checklist',
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
  const mode = str(input['mode']);
  // Lifecycle operations observe or reduce only manager/session-owned work. They
  // run no new user-supplied command and are therefore statically safe.
  if (mode === 'restart') {
    return { toolName, kind: 'read', summary: 'bash: restart session', details: [], input: rawInput };
  }
  if (mode === 'list') {
    return { toolName, kind: 'read', summary: 'bash: list background tasks', details: [], input: rawInput };
  }
  if (mode === 'status' || mode === 'output' || mode === 'wait' || mode === 'stop') {
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
  if (mode !== 'start' && typeof timeout === 'number') {
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
      details.push({ label: 'New content', value: str(input['file_text']) ?? '', editContent: true });
      break;
    case 'str_replace':
      details.push({ label: 'Replace', value: str(input['old_str']) ?? '', editContent: true });
      // new_str is optional: omitting it deletes the matched text.
      details.push({
        label: 'With',
        value: str(input['new_str']) ?? '(deletes the matched text)',
        editContent: true,
      });
      break;
    case 'insert':
      details.push({ label: 'At line', value: String(input['insert_line'] ?? '?') });
      details.push({ label: 'Insert', value: str(input['new_str']) ?? '', editContent: true });
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

  if (isSensitiveDarwinPath(projectRoot, resolved)) {
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

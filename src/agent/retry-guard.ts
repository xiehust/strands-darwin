import {
  InterventionActions,
  InterventionHandler,
  type AfterToolCallEvent,
  type BeforeInvocationEvent,
  type BeforeModelCallEvent,
  type BeforeToolCallEvent,
} from '@strands-agents/sdk';

const MAX_TOOLS = 16;
const MAX_FAILURES_PER_TOOL = 8;
const MAX_INPUT_CODE_POINTS = 480;

export const RETRY_GUARD_SIGNATURE_CODE_POINTS = 320;
export const RETRY_GUARD_MESSAGE_CODE_POINTS = 900;
export const REPEATED_FAILURE_LIMIT = 3;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const LONG_HEX = /\b(?:0x)?[0-9a-f]{12,}\b/giu;
const URL = /\bhttps?:\/\/\S+/giu;
const ABSOLUTE_PATH = /(?:^|\s)(?:\/[\p{L}\p{N}._~+%-]+){2,}/gu;
const QUOTED_VALUE = /(["'`])(?:\\.|(?!\1)[^\\])*\1/gu;
const NUMBER = /\b\d+(?:\.\d+)?\b/gu;
const CONTROL = /[\p{Cc}\p{Cf}]+/gu;

interface FailureProjection {
  readonly className: string;
  readonly signature: string;
  readonly key: string;
}

interface FailureEntry {
  readonly failure: FailureProjection;
  readonly attemptInputs: string[];
  count: number;
}

interface ToolFailures {
  readonly entries: Map<string, FailureEntry>;
}

interface InvocationFailures {
  readonly invocationState: object;
  readonly tools: Map<string, ToolFailures>;
  pendingGuidance: string | undefined;
}

type BeforeAction = Awaited<ReturnType<InterventionHandler['beforeToolCall']>>;
type AfterAction = Awaited<ReturnType<InterventionHandler['afterToolCall']>>;
type InvocationAction = Awaited<ReturnType<InterventionHandler['beforeInvocation']>>;
type ModelAction = Awaited<ReturnType<InterventionHandler['beforeModelCall']>>;

/**
 * Bounds repeated model-driven tool failures without taking over the SDK loop.
 *
 * One instance may be shared by a parent and all children: the outer WeakMap makes
 * counters Agent-local, while BeforeInvocation replaces each Agent's turn state.
 */
export class RepeatedFailureGuard extends InterventionHandler {
  readonly name = 'darwin:repeated-failure-guard';
  private readonly invocations = new WeakMap<object, InvocationFailures>();

  override beforeInvocation(event: BeforeInvocationEvent): InvocationAction {
    this.invocations.set(event.agent, {
      invocationState: event.invocationState,
      tools: new Map(),
      pendingGuidance: undefined,
    });
    return InterventionActions.proceed();
  }

  override beforeToolCall(event: BeforeToolCallEvent): BeforeAction {
    // Unknown tools retain the SDK/permission behavior. Direct tool calls have no
    // active BeforeInvocation state and are likewise outside this model-loop guard.
    if (event.tool === undefined) return InterventionActions.proceed();
    const state = this.activeState(event.agent, event.invocationState);
    if (state === undefined) return InterventionActions.proceed();

    const tool = state.tools.get(event.toolUse.name);
    if (tool === undefined) return InterventionActions.proceed();
    const blocked = [...tool.entries.values()].find(
      (entry) => entry.count >= REPEATED_FAILURE_LIMIT &&
        entry.attemptInputs.every((prior) => !materiallySameInput(prior, event.toolUse.input)),
    );
    if (blocked === undefined) return InterventionActions.proceed();

    return InterventionActions.deny(stopMessage(event.toolUse.name, blocked.failure));
  }

  override afterToolCall(event: AfterToolCallEvent): AfterAction {
    const state = this.activeState(event.agent, event.invocationState);
    if (state === undefined || event.tool === undefined) return InterventionActions.proceed();

    const failure = failedOutcome(event);
    if (failure === undefined) {
      state.tools.delete(event.toolUse.name);
      return InterventionActions.proceed();
    }

    const tool = getOrInsertBounded(state.tools, event.toolUse.name, () => ({ entries: new Map() }), MAX_TOOLS);
    const entry = getOrInsertBounded(
      tool.entries,
      failure.key,
      () => ({ failure, attemptInputs: [], count: 0 }),
      MAX_FAILURES_PER_TOOL,
    );
    entry.attemptInputs.push(boundedInput(event.toolUse.input));
    entry.count += 1;

    if (entry.count === 2) {
      state.pendingGuidance = hypothesisMessage(event.toolUse.name, failure);
    } else if (entry.count === REPEATED_FAILURE_LIMIT) {
      state.pendingGuidance = stopMessage(event.toolUse.name, failure);
    }
    return InterventionActions.proceed();
  }

  override beforeModelCall(event: BeforeModelCallEvent): ModelAction {
    const state = this.activeState(event.agent, event.invocationState);
    const guidance = state?.pendingGuidance;
    if (state === undefined || guidance === undefined) return InterventionActions.proceed();
    state.pendingGuidance = undefined;
    return InterventionActions.guide(guidance, { reason: 'bounded repeated tool failure' });
  }

  private activeState(agent: object, invocationState: object): InvocationFailures | undefined {
    const state = this.invocations.get(agent);
    return state?.invocationState === invocationState ? state : undefined;
  }
}

/** Stable bounded projection used for both retained keys and model-visible diagnostics. */
export function normalizeFailureSignature(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(CONTROL, ' ')
    .replace(URL, ' <url>')
    .replace(UUID, '<uuid>')
    .replace(LONG_HEX, '<hex>')
    .replace(ABSOLUTE_PATH, ' <path>')
    .replace(QUOTED_VALUE, '<quoted>')
    .replace(NUMBER, '<number>')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, ' ')
    .trim();
  return sliceCodePoints(normalized === '' ? '(no error text)' : normalized, RETRY_GUARD_SIGNATURE_CODE_POINTS);
}

function failedOutcome(event: AfterToolCallEvent): FailureProjection | undefined {
  const bash = bashFailureText(event);
  if (bash !== undefined) return failureProjection('bash-command-error', bash);
  if (event.result.status !== 'error') return undefined;

  const className = boundedClassName(event.error?.name ?? event.result.error?.name ?? 'tool-error');
  const text = event.error?.message ?? event.result.error?.message ?? resultText(event);
  return failureProjection(className, text);
}

function failureProjection(className: string, text: string): FailureProjection {
  const boundedClass = boundedClassName(className);
  const signature = normalizeFailureSignature(text);
  return { className: boundedClass, signature, key: `${boundedClass}\u0000${signature}` };
}

function bashFailureText(event: AfterToolCallEvent): string | undefined {
  if (event.toolUse.name !== 'bash' || event.result.status !== 'success') return undefined;
  for (const block of event.result.content) {
    if (block.type !== 'jsonBlock' || !isRecord(block.json)) continue;
    const directExit = block.json['exitCode'];
    if (typeof directExit === 'number' && directExit !== 0) return `exit code ${directExit}: ${stringField(block.json, 'error')}`;
    if (block.json['state'] === 'failed') return jsonText(block.json);
    const status = block.json['status'];
    if (isRecord(status) && status['state'] === 'failed') return jsonText(block.json);
    if (isRecord(event.toolUse.input) && event.toolUse.input['mode'] === 'execute') {
      const exitCode = block.json['exitCode'];
      if (typeof exitCode === 'number' && exitCode !== 0) {
        return `exit code ${exitCode}: ${stringField(block.json, 'error')}`;
      }
    }
  }
  return undefined;
}

function resultText(event: AfterToolCallEvent): string {
  const parts: string[] = [];
  for (const block of event.result.content.slice(0, 4)) {
    if (block.type === 'textBlock') parts.push(block.text);
    else if (block.type === 'jsonBlock') parts.push(jsonText(block.json));
    else parts.push(`[${block.type}]`);
  }
  return parts.join(' ') || '(no error text)';
}

function materiallySameInput(prior: string, input: unknown): boolean {
  // Pre-execution equivalence is intentionally exact after bounded canonical JSON.
  // A changed input may still yield the same signature and is the attempt the cap
  // can safely stop; an exact rerun cannot be predicted to fail before it executes.
  return prior === boundedInput(input);
}

function boundedInput(input: unknown): string {
  return sliceCodePoints(stableInput(input, 0), MAX_INPUT_CODE_POINTS);
}

function stableInput(value: unknown, depth: number): string {
  if (depth >= 4) return '<depth>';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(sliceCodePoints(value.normalize('NFKC'), 160));
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '<non-finite>';
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.slice(0, 8).map((item) => stableInput(item, depth + 1)).join(',')}${value.length > 8 ? ',…' : ''}]`;
  }
  if (!isRecord(value)) return `<${typeof value}>`;
  const keys = Object.keys(value).sort();
  const shown = keys.slice(0, 16).map(
    (key) => `${JSON.stringify(sliceCodePoints(key, 64))}:${stableInput(value[key], depth + 1)}`,
  );
  return `{${shown.join(',')}${keys.length > 16 ? ',…' : ''}}`;
}


function hypothesisMessage(toolName: string, failure: FailureProjection): string {
  return boundedMessage(
    `[Repeated-failure guard] ${toolName} has now returned the same ${failure.className} failure twice: ${failure.signature}. ` +
      'Before any retry, state a materially new evidence-backed hypothesis and the evidence that distinguishes the next attempt from the failed ones. Do not make a speculative parameter variant.',
  );
}

function stopMessage(toolName: string, failure: FailureProjection): string {
  return boundedMessage(
    `[Repeated-failure guard] ${toolName} reached the limit of ${REPEATED_FAILURE_LIMIT} materially equivalent ${failure.className} failures: ${failure.signature}. ` +
      'Stop retrying in this turn. Report this blocker and the artifacts or evidence already collected, then ask the user before continuing in a new turn.',
  );
}

function boundedMessage(value: string): string {
  return sliceCodePoints(value, RETRY_GUARD_MESSAGE_CODE_POINTS);
}

function boundedClassName(value: string): string {
  const normalized = value.normalize('NFKC').replace(CONTROL, ' ').replace(/[^\p{L}\p{N}_.:-]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return sliceCodePoints(normalized === '' ? 'tool-error' : normalized, 64);
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable result]';
  }
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' ? field : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sliceCodePoints(value: string, limit: number): string {
  const points = [...value];
  return points.length <= limit ? value : `${points.slice(0, limit - 1).join('')}…`;
}

function getOrInsertBounded<K, V>(map: Map<K, V>, key: K, create: () => V, limit: number): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  if (map.size >= limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }
  const value = create();
  map.set(key, value);
  return value;
}

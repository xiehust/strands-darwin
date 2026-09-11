import type { AfterToolCallEvent, BeforeToolCallEvent, BeforeToolsEvent, ToolResultEvent } from '@strands-agents/sdk';
import type { TurnSettlement } from '../trajectory/writer.js';

export const MAX_ACTION_BYTES = 8192;
export const MAX_EVENT_BYTES = 262144;
export const MAX_EVENT_STATE_BYTES = MAX_EVENT_BYTES + 1024;
export const UPLOAD_NOTICE = 'Bounded original public tool content; can include secrets. NOT a confidentiality guarantee. No assistant prose/reasoning, binary/images, child traversal or file/offload/archive hydration. Upstream loss may be undetectable. taskSuccess is not inferred.';
const MAX_ACTIONS = 64;
const MAX_SUMMARIES = 96;
const MAX_SCAN_UNITS = 262144;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export interface TextSlice {
  originalBytes: number | null;
  originalUnits: number;
  retainedBytes: number;
  ranges: [number, number][];
  rangeUnit: 'utf16';
  parts: string[];
  truncated: boolean;
  sourceLoss: string[];
}
/** Never encode an unbounded source. Offsets are explicit UTF-16 boundaries, never
 * split a surrogate pair; retained byte counts refer to UTF-8, not JSON escaping. */
export function sliceText(text: string, limit: number): TextSlice {
  const known = text.length <= MAX_SCAN_UNITS;
  const originalBytes = known ? Buffer.byteLength(text) : null;
  const take = (start: number, end: number, cap: number, tail = false) => {
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start++;
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
    let value = text.slice(start, end);
    while (Buffer.byteLength(value) > cap) {
      if (tail) start += (text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1;
      else end -= end > 1 && /[\uDC00-\uDFFF]/.test(text[end - 1]!) && /[\uD800-\uDBFF]/.test(text[end - 2]!) ? 2 : 1;
      value = text.slice(start, end);
    }
    // Copy bounded bytes so a slice cannot keep a huge backing source alive.
    return { text: JSON.parse(JSON.stringify(value)) as string, range: [start, end] as [number, number] };
  };
  const full = originalBytes !== null && originalBytes <= limit;
  const head = full ? take(0, text.length, limit) : take(0, Math.min(text.length, Math.floor(limit / 3)), Math.floor(limit / 3));
  const tail = full ? undefined : take(Math.max(head.range[1], text.length - (limit - Math.floor(limit / 3))), text.length, limit - Math.floor(limit / 3), true);
  const pieces = tail === undefined ? [head] : [head, tail];
  return { originalBytes, originalUnits: text.length, retainedBytes: pieces.reduce((n, p) => n + Buffer.byteLength(p.text), 0), ranges: pieces.map(p => p.range), rangeUnit: 'utf16', parts: pieces.map(p => p.text), truncated: !full,
    sourceLoss: known ? [] : ['Original byte length not measured: source exceeds bounded scan; UTF-16 length and retained ranges are exact.'] };
}
interface Loss { path: string; reason: string; text?: Omit<TextSlice, 'parts'> }
interface Captured { content: unknown; losses: Loss[] }
// Only descriptors: even array indices and SDK block fields can be accessors.
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && 'value' in property ? property.value : undefined;
}
function indices(length: number): number[] {
  return length <= 32 ? Array.from({ length }, (_, i) => i)
    : [...Array.from({ length: 16 }, (_, i) => i), ...Array.from({ length: 16 }, (_, i) => length - 16 + i)];
}
type Snapshot = { scalar: unknown } | { text: TextSlice } | { entries: [string, Snapshot][]; length?: number; losses: Loss[] };
const omitted = (reason: string): Snapshot => ({ entries: [], losses: [{ path: '', reason }] });
const childPath = (path: string, key: string) => `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
/** Bounded discovery BEFORE allocation: a long early value cannot starve known
 * short siblings. Never serialize the source, call toJSON or evaluate accessors.
 * The temporary snapshot has <=128 values, depth 8, <=32 entries/container and
 * <=8192 copied UTF-8 bytes/string. No source object or large backing string lives
 * beyond this call. Retained snapshots are pruned to the serialized action cap. */
function snapshot(value: unknown): Snapshot {
  let nodes = 0;
  const visit = (item: unknown, depth: number, ceiling = 128): Snapshot => {
    if (nodes >= ceiling || depth > 8) return omitted('Traversal budget: entire region omitted');
    nodes++;
    if (typeof item === 'string') return { text: sliceText(item, MAX_ACTION_BYTES) };
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return { scalar: item };
    if (typeof item !== 'object' || ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return omitted('Binary or non-JSON value omitted');
    if (['imageBlock', 'audioBlock', 'videoBlock', 'documentBlock', 'image', 'audio'].includes(own(item, 'type') as string)) return omitted('Structured media payload omitted');
    const array = Array.isArray(item);
    const length = array ? own(item, 'length') as number : undefined;
    const keys: string[] = []; const losses: Loss[] = [];
    if (length !== undefined) {
      keys.push(...indices(length).map(String));
      if (length > 32) losses.push({ path: '', reason: `Array middle omitted: indices [16, ${length - 16}); original length ${length}` });
    } else {
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (keys.length === 32) { losses.push({ path: '', reason: 'Remaining object properties omitted; count not traversed' }); break; }
        keys.push(key);
      }
    }
    const entries: [string, Snapshot][] = [];
    // Reserve one visit for each discovered sibling; deeper trees share the rest.
    for (const [index, key] of keys.entries()) {
      if (key.length > 128) { losses.push({ path: '', reason: 'Oversized property name and its value omitted' }); continue; }
      const property = Object.getOwnPropertyDescriptor(item, key);
      entries.push([key, !property || !('value' in property) ? omitted('Accessor or absent own value omitted without evaluation') : visit(property.value, depth + 1, ceiling - (keys.length - index - 1))]);
    }
    return { entries, ...(length === undefined ? {} : { length }), losses };
  };
  return visit(value, 0);
}
function project(source: Snapshot): Captured {
  const losses: Loss[] = []; let lossBytes = 0; let extra = false;
  const loss = (entry: Loss) => {
    const bounded = { ...entry, path: sliceText(entry.path, 128).parts.join('') };
    const size = bytes(bounded);
    if (losses.length < 4 && lossBytes + size <= 1200) { losses.push(bounded); lossBytes += size; } else extra = true;
  };
  const visit = (node: Snapshot, path: string): unknown => {
    if ('scalar' in node) return node.scalar;
    if ('text' in node) {
      const { parts, ...text } = node.text;
      if (text.truncated || text.sourceLoss.length) { loss({ path, reason: 'Exact head/tail; middle omitted', text }); return parts; }
      return parts[0];
    }
    for (const entry of node.losses) loss({ ...entry, path: path + entry.path });
    if (node.length !== undefined) {
      if (node.entries.length === node.length) return node.entries.map(([key, value]) => visit(value, childPath(path, key)));
      return { originalLength: node.length, entries: node.entries.map(([key, value]) => ({ index: Number(key), value: visit(value, childPath(path, key)) })) };
    }
    return Object.fromEntries(node.entries.map(([key, value]) => [key, visit(value, childPath(path, key))]));
  };
  const content = visit(source, '');
  if (extra) losses.push({ path: '', reason: 'Additional bounded traversal losses aggregated; no omitted region is represented as complete' });
  return { content, losses };
}
/** Re-cut only copied source ranges, mapping them back to the original string.
 * This also allows an input snapshot to release space for a later large result. */
function shrinkText(source: TextSlice, limit: number): TextSlice {
  const parts: string[] = []; const ranges: [number, number][] = [];
  const headBudget = Math.floor(limit / 3);
  const first = source.parts[0]!; const last = source.parts.at(-1)!;
  const clip = (text: string, cap: number, tail: boolean) => {
    let start = tail ? Math.max(0, text.length - cap) : 0;
    let end = tail ? text.length : Math.min(text.length, cap);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start++;
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
    while (Buffer.byteLength(text.slice(start, end)) > cap) {
      if (tail) start += (text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1;
      else end -= end > 1 && /[\uDC00-\uDFFF]/.test(text[end - 1]!) && /[\uD800-\uDBFF]/.test(text[end - 2]!) ? 2 : 1;
    }
    return JSON.parse(JSON.stringify(text.slice(start, end))) as string;
  };
  const head = clip(first, headBudget, false);
  const tail = clip(last, limit - headBudget, true);
  parts.push(head, tail);
  ranges.push([source.ranges[0]![0], source.ranges[0]![0] + head.length], [source.ranges.at(-1)![1] - tail.length, source.ranges.at(-1)![1]]);
  return { ...source, parts, ranges, retainedBytes: parts.reduce((n, part) => n + Buffer.byteLength(part), 0), truncated: true };
}
function reduceSnapshot(source: Snapshot, excess: number): boolean {
  const texts: Extract<Snapshot, { text: TextSlice }>[] = [];
  const containers: Extract<Snapshot, { entries: unknown }>[] = [];
  const walk = (node: Snapshot) => {
    if ('text' in node) texts.push(node);
    else if ('entries' in node) { containers.push(node); for (const [, value] of node.entries) walk(value); }
  };
  walk(source);
  const largest = texts.sort((a, b) => bytes(b.text.parts) - bytes(a.text.parts))[0];
  if (largest && largest.text.retainedBytes > 64) {
    largest.text = shrinkText(largest.text, Math.max(32, largest.text.retainedBytes - Math.max(64, Math.ceil(excess / 6))));
    return true;
  }
  const container = containers.filter(node => node.entries.length).sort((a, b) => bytes(project(b)) - bytes(project(a)))[0];
  if (!container) return false;
  const [key] = container.entries.splice(Math.floor(container.entries.length / 2), 1)[0]!;
  container.losses = [{ path: '', reason: 'Serialized budget: collection entries omitted (retained keys/indices are exact)' }];
  if (container.length === undefined) container.losses[0]!.reason += `; including ${sliceText(key, 64).parts.join('')}`;
  return true;
}
function fit(source: Snapshot, budget: number): Captured {
  let result = project(source);
  // Each step shrinks a string by >=64 bytes or removes an entry. Bound even for
  // escape-heavy/deep trees; final fallback is explicit, never an oversized action.
  for (let i = 0; bytes(result) > budget && i < 512; i++) {
    if (!reduceSnapshot(source, bytes(result) - budget)) break;
    result = project(source);
  }
  if (bytes(result) > budget) {
    // Release the bounded discovery tree too, not merely its rendered content.
    if ('entries' in source) { source.entries = []; source.losses = [{ path: '', reason: 'Serialized budget: entire region omitted' }]; }
    else if ('text' in source) source.text = shrinkText(source.text, 0);
    result = project(source);
  }
  return result;
}
export function capture(value: unknown, budget = MAX_ACTION_BYTES - 1): Captured {
  return fit(snapshot(value), budget);
}

type Action = { ordinal: number; invocation: string; invocationScope: number; attempt: number; tool: string; inputSource: string; input: Captured; result: { status: string; evidence: string; exitCode?: number; content: Captured } | { missing: string }; failed: boolean; recovery: boolean; sourceLoss: string[] };
type Summary = Pick<Action, 'ordinal' | 'invocation' | 'tool' | 'failed' | 'recovery'> & { status: string; exitCode?: number; bodyOmitted: true };
function summary(action: Action): Summary {
  return { ordinal: action.ordinal, invocation: action.invocation, tool: action.tool, failed: action.failed, recovery: action.recovery, status: 'status' in action.result ? action.result.status : action.result.missing,
    ...('exitCode' in action.result ? { exitCode: action.result.exitCode } : {}), bodyOmitted: true };
}
function priority(action: Action | Summary): number { return action.failed || action.recovery ? 1 : 0; }
function comparePriority(a: Action | Summary, b: Action | Summary): number { return priority(a) - priority(b) || a.ordinal - b.ordinal; }
function toolText(content: unknown): { value: unknown[]; loss: string[]; exitCode?: number } {
  const value: unknown[] = []; const loss = new Set<string>(); let exitCode: number | undefined;
  if (!Array.isArray(content)) return { value, loss: ['SDK result content unavailable'] };
  const length = own(content, 'length') as number;
  value.length = length;
  for (const i of indices(length)) {
    const block = own(content, String(i));
    const kind = own(block, 'type'); const text = own(block, 'text');
    if (kind === 'textBlock' && typeof text === 'string') {
      value[i] = { text };
      if (/\[.*(?:offload|truncat)|truncated:|retrieve_offloaded_content/i.test(text.slice(0, 1024))) loss.add('SDK text signals possible upstream truncation/offload; not hydrated');
    } else if (kind === 'jsonBlock' && Object.getOwnPropertyDescriptor(block, 'json')?.get === undefined) {
      const json = own(block, 'json'); value[i] = { json };
      const code = own(json, 'exitCode');
      if (typeof code === 'number' && Number.isInteger(code)) exitCode = code;
    } else loss.add('Non-text/JSON SDK block or accessor omitted without evaluation (binary/image or unsupported)');
  }
  return { value, loss: [...loss], ...(exitCode === undefined ? {} : { exitCode }) };
}

export class UploadTurn {
  readonly goal: TextSlice;
  readonly actions: Action[] = [];
  readonly summaries: Summary[] = [];
  readonly pending = new Map<string, Action>();
  private scopes = new WeakMap<object, number>();
  private scopeCount = 0;
  private calls = new Map<string, { action?: Action; attempt: number; started: boolean; ambiguous: boolean }>();
  private inputs = new WeakMap<Action, Snapshot>();
  totalActions = 0;
  internalEvents = 0;
  batchEntriesOmitted = 0;
  unmatchedResults = 0;
  aggregatedActions = 0;
  observerErrors = 0;
  private lastFailed = false;
  private key(state: object, id: string, create = false): string | undefined {
    let scope = this.scopes.get(state);
    if (scope === undefined && create) { scope = ++this.scopeCount; this.scopes.set(state, scope); }
    return scope === undefined ? undefined : `${scope}:${id}`;
  }
  /** Bounded batch intent supplies identity/input when cancellation skips BeforeToolCall.
   * A later BeforeToolCall replaces intent with the effective execution input. */
  batch(event: BeforeToolsEvent): void {
    const content = own(event.message, 'content');
    if (!Array.isArray(content)) return;
    const length = own(content, 'length') as number;
    if (length > 32) this.batchEntriesOmitted += length - 32;
    for (const index of indices(length)) {
      const use = own(content, String(index));
      if (own(use, 'type') === 'toolUseBlock') this.add(use, event.invocationState, false);
    }
  }
  constructor(readonly turn: number, goal: string) { this.goal = sliceText(goal, 8192); }
  private omit(action: Action) {
    this.summaries.push(summary(action));
    if (this.summaries.length > MAX_SUMMARIES) { this.summaries.shift(); this.aggregatedActions++; }
  }
  before(event: BeforeToolCallEvent): void { this.add(event.toolUse, event.invocationState, true); }
  private add(use: unknown, state: object, started: boolean): void {
    const rawId = own(use, 'toolUseId'); const name = own(use, 'name');
    const validId = typeof rawId === 'string' && rawId.length <= 256;
    const id = validId ? rawId : `unavailable-${this.totalActions + 1}`;
    const key = this.key(state, id, true)!;
    const prior = this.calls.get(key);
    // Intent is not a second attempt. Duplicate IDs otherwise lack a public
    // attempt token: refuse pairing, even if an older result had already arrived.
    const intent = started && prior && !prior.started && !prior.ambiguous ? prior.action : undefined;
    const ordinal = intent?.ordinal ?? ++this.totalActions;
    const input = snapshot(own(use, 'input'));
    const action: Action = intent ?? { ordinal, invocation: id, invocationScope: this.scopes.get(state)!, attempt: (prior?.attempt ?? 0) + 1,
      tool: '', inputSource: '', input: project(input), result: { missing: 'No corresponding result observed (cancelled, incomplete or still pending)' }, failed: false, recovery: this.lastFailed, sourceLoss: [] };
    action.tool = typeof name === 'string' ? sliceText(name, 256).parts.join('') : '(unavailable)';
    action.inputSource = started ? 'BeforeToolCall execution input' : 'BeforeTools requested input; execution not observed';
    action.input = project(input);
    if (!validId) action.sourceLoss.push('Oversized/missing SDK identity omitted; corresponding result cannot be matched');
    if (typeof name === 'string' && (name.length > 512 || Buffer.byteLength(name.slice(0, 512)) > 256)) action.sourceLoss.push('Tool name head/tail truncated to 256 bytes');
    this.lastFailed = false;
    if (!intent && prior) {
      action.sourceLoss.push('SDK ID reused within invocation state; result attribution refused');
      action.result = { missing: 'Ambiguous reused SDK ID; result attribution refused' };
      if (prior.action && 'missing' in prior.action.result) prior.action.result.missing = 'Ambiguous reused SDK ID; result attribution refused';
      this.pending.delete(key);
    }
    // Keep identity tombstones even for evicted actions. Once full, never forget
    // identities and risk attaching a delayed result to a reused ID.
    const track = validId && (prior !== undefined || this.calls.size < 512);
    if (!track) {
      action.sourceLoss.push('Identity ledger unavailable/full (512 keys); results remain unmatched');
      action.result = { missing: 'Identity unavailable/full; observed results cannot be safely attributed' };
    }
    if (track) {
      this.calls.set(key, { action, attempt: action.attempt, started, ambiguous: !intent && prior !== undefined || prior?.ambiguous === true });
      if (!this.calls.get(key)!.ambiguous) this.pending.set(key, action);
    }
    this.fitAction(action, input);
    this.inputs.set(action, input);
    if (!intent) this.actions.push(action);
    if (this.actions.length > MAX_ACTIONS) {
      const candidates = this.actions.slice(0, -16);
      const victim = candidates.reduce((a, b) => comparePriority(a, b) < 0 ? a : b);
      this.actions.splice(this.actions.indexOf(victim), 1);
      const victimKey = `${victim.invocationScope}:${victim.invocation}`;
      if (this.pending.get(victimKey) === victim) this.pending.delete(victimKey);
      const record = this.calls.get(victimKey);
      if (record?.action === victim) delete record.action;
      this.inputs.delete(victim); this.omit(victim);
    }
  }
  private fitAction(action: Action, input: Snapshot, result?: Snapshot): void {
    for (let i = 0; bytes(action) > MAX_ACTION_BYTES && i < 512; i++) {
      const source = result && 'content' in action.result && bytes(action.result.content) > bytes(action.input) ? result : input;
      if (!reduceSnapshot(source, bytes(action) - MAX_ACTION_BYTES)) break;
      action.input = project(input);
      if (result && 'content' in action.result) action.result.content = project(result);
    }
    if (bytes(action) > MAX_ACTION_BYTES) {
      action.input = fit(input, 512);
      if (result && 'content' in action.result) action.result.content = fit(result, 512);
    }
  }
  after(event: AfterToolCallEvent): void { this.result(event.invocationState, event.result, 'pre-after-hook execution evidence; not necessarily final model-visible output'); }
  fallback(event: ToolResultEvent): void { this.result(event.invocationState, event.result, 'observed public ToolResultEvent fallback; no pre-after-hook snapshot available'); }
  private result(state: object, result: unknown, evidence: string): void {
    const id = own(result, 'toolUseId');
    const key = typeof id === 'string' ? this.key(state, id) : undefined;
    const record = key === undefined ? undefined : this.calls.get(key);
    const action = record?.action;
    if (!action || record?.ambiguous) { this.unmatchedResults++; return; }
    // A public final/offloaded result or a later background completion must never
    // overwrite original evidence (or an earlier dispatch acknowledgement).
    if ('status' in action.result) return;
    const text = toolText(own(result, 'content'));
    const captured = snapshot(text.value);
    const status = own(result, 'status');
    action.result = { status: status === 'success' || status === 'error' ? status : 'not reported', evidence,
      ...(text.exitCode === undefined ? {} : { exitCode: text.exitCode }), content: project(captured) };
    action.sourceLoss.push(...text.loss);
    action.failed = status === 'error' || text.exitCode !== undefined && text.exitCode !== 0;
    this.lastFailed = action.failed;
    this.pending.delete(key!);
    this.fitAction(action, this.inputs.get(action)!, captured);
    this.inputs.delete(action);
  }
  finish(): void { this.pending.clear(); this.calls.clear(); this.inputs = new WeakMap(); this.scopes = new WeakMap(); }
}

/** Parent-only pre-after-hook execution capture plus public-result fallback.
 * No I/O, async work, Agent/event serialization, model calls or SDK mutation. */
export class UploadObserver {
  private active: UploadTurn | undefined;
  private turns = new Map<number, UploadTurn>();
  private invocations = new WeakMap<object, number>();
  droppedTurns = 0;
  get retainedTurns(): number { return this.turns.size; }
  batch(event: BeforeToolsEvent): void { this.safely(turn => { this.invocations.set(event.invocationState, turn.turn); turn.batch(event); }); }
  before(event: BeforeToolCallEvent): void { this.safely(turn => { this.invocations.set(event.invocationState, turn.turn); turn.before(event); }); }
  fallback(event: ToolResultEvent): void {
    this.safely(turn => {
      if (this.invocations.get(event.invocationState) !== turn.turn) { turn.unmatchedResults++; return; }
      turn.fallback(event);
    });
  }
  after(event: AfterToolCallEvent): void {
    this.safely(turn => {
      if (this.invocations.get(event.invocationState) !== turn.turn) { turn.unmatchedResults++; return; }
      turn.after(event);
    });
  }
  private safely(observe: (turn: UploadTurn) => void): void {
    if (!this.active) return;
    try { observe(this.active); } catch { this.active.observerErrors++; }
  }
  begin(turn: number, goal: string): void {
    this.end(); this.invocations = new WeakMap();
    if (this.turns.size >= 8) { this.droppedTurns++; return; }
    try { this.active = new UploadTurn(turn, goal); this.turns.set(turn, this.active); } catch { this.active = undefined; }
  }
  internal(): void { if (this.active) this.active.internalEvents++; }
  end(): void { this.active?.finish(); this.active = undefined; }
  take(turn: number): UploadTurn | undefined {
    const value = this.turns.get(turn); this.turns.delete(turn);
    if (this.active === value) this.end();
    value?.finish(); return value;
  }
  clear(): void { this.end(); this.turns.clear(); this.invocations = new WeakMap(); }
}

type Envelope = { memoryId: string; actorId: string; sessionId: string; eventTimestamp: string; clientToken: string; extractionConfig: { namespaceVariables: { projectid: string } } };
const message = (role: 'USER' | 'TOOL' | 'OTHER', text: string) => ({ conversational: { role, content: { text } } });
export function uploadBody(envelope: Envelope, turn: UploadTurn, settlement: Extract<TurnSettlement, { durable: true }>) {
  if (turn.goal.retainedBytes === 0 && turn.actions.length === 0) return undefined;
  const selected: Action[] = [];
  const omitted: Summary[] = [...turn.summaries];
  // Reserve goal + closing/quality metadata independently of action selection.
  const source = {
    format: 'darwin-upload-v2', session: settlement.session, turn: settlement.turn, closingSeq: settlement.seq, at: settlement.at,
    outcome: settlement.failure ? 'failed' : settlement.stopReason === 'cancelled' ? 'cancelled' : settlement.partial || !settlement.stopReason ? 'incomplete' : 'closed',
    stopReason: settlement.stopReason ?? 'not reported', taskSuccess: 'not inferred',
    goal: { ...turn.goal, parts: undefined, present: turn.goal.retainedBytes > 0 },
    omissions: UPLOAD_NOTICE,
  };
  const render = (summaries: Summary[]) => {
    const quality = { completeActions: selected.filter(a => 'status' in a.result).length, missingResults: selected.filter(a => 'missing' in a.result).length,
      contentTruncatedActions: selected.filter(a => a.input.losses.length || 'content' in a.result && a.result.content.losses.length).length,
      sourceLimitedActions: selected.filter(a => a.sourceLoss.length || a.input.losses.some(l => l.text?.sourceLoss.length) || 'content' in a.result && a.result.content.losses.some(l => l.text?.sourceLoss.length)).length,
      actionBodiesOmitted: turn.totalActions - selected.length, actionSummariesOmitted: turn.totalActions - selected.length - summaries.length,
      internalEventsExcluded: turn.internalEvents, batchEntriesOmitted: turn.batchEntriesOmitted, unmatchedResults: turn.unmatchedResults, observerErrors: turn.observerErrors };
    return { ...envelope, payload: [message('OTHER', JSON.stringify({ ...source, quality, omittedActions: summaries })),
      ...(turn.goal.retainedBytes ? [message('USER', turn.goal.parts.join(''))] : []),
      ...[...selected].sort((a, b) => a.ordinal - b.ordinal).map(a => message('TOOL', JSON.stringify(a))) ] };
  };
  const recent = turn.actions.slice(-16);
  const ranked = [...recent].reverse().concat(turn.actions.filter(a => !recent.includes(a)).sort((a, b) => comparePriority(b, a)));
  for (const action of ranked) {
    selected.push(action);
    // 16KiB reserved for bounded omitted-action summaries.
    if (bytes(render([])) > MAX_EVENT_BYTES - 16384 || selected.length > 98) { selected.pop(); omitted.push(summary(action)); }
  }
  const summaries: Summary[] = [];
  for (const item of omitted.sort((a, b) => b.ordinal - a.ordinal)) {
    summaries.push(item);
    const candidate = render(summaries);
    if (bytes(candidate) > MAX_EVENT_BYTES || Buffer.byteLength(candidate.payload[0]!.conversational.content.text) > 100000) { summaries.pop(); break; }
  }
  summaries.sort((a, b) => a.ordinal - b.ordinal);
  return render(summaries);
}

export function uploadQuality(text: string): string {
  const source = JSON.parse(text);
  if (source.format !== 'darwin-upload-v2') return 'legacy projection (unchanged)';
  const q = source.quality;
  return `goal ${source.goal.present ? 'present' : 'absent'}${source.goal.truncated ? ' (truncated)' : ''}; ${q.completeActions} complete actions; ${q.missingResults} missing results; ${q.contentTruncatedActions} content-truncated; ${q.actionBodiesOmitted} action bodies omitted; ${q.sourceLimitedActions} source-limited; task success not inferred`;
}

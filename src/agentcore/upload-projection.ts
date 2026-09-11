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
function clipText(text: string, start: number, end: number, cap: number, tail = false) {
  const split = (at: number) => at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!);
  // Empty ranges must remain empty, including at a lone low surrogate.
  if (start < end) {
    if (split(start)) start++;
    if (split(end)) end--;
  }
  let retained = 0; let cursor = tail ? end : start;
  // Visit at most cap + one codepoint, not repeated whole-prefix encodings.
  while (tail ? cursor > start : cursor < end) {
    const width = tail ? (split(cursor - 1) ? 2 : 1) : ((text.codePointAt(cursor) ?? 0) > 0xffff ? 2 : 1);
    const point = tail ? text.codePointAt(cursor - width)! : text.codePointAt(cursor)!;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (retained + size > cap) break;
    retained += size; cursor += tail ? -width : width;
  }
  if (tail) start = cursor; else end = cursor;
  // Copy bounded bytes without replacing lone surrogates or retaining source backing.
  return { text: JSON.parse(JSON.stringify(text.slice(start, end))) as string, range: [start, end] as [number, number] };
}
export function sliceText(text: string, limit: number): TextSlice {
  const known = text.length <= MAX_SCAN_UNITS;
  const originalBytes = known ? Buffer.byteLength(text) : null;
  const take = (start: number, end: number, cap: number, tail = false) => clipText(text, start, end, cap, tail);
  const full = originalBytes !== null && originalBytes <= limit;
  const head = full ? take(0, text.length, limit) : take(0, Math.min(text.length, Math.floor(limit / 3)), Math.floor(limit / 3));
  const tail = full ? undefined : take(Math.max(head.range[1], text.length - (limit - Math.floor(limit / 3))), text.length, limit - Math.floor(limit / 3), true);
  const pieces = tail === undefined ? [head] : [head, tail];
  return { originalBytes, originalUnits: text.length, retainedBytes: pieces.reduce((n, p) => n + Buffer.byteLength(p.text), 0), ranges: pieces.map(p => p.range), rangeUnit: 'utf16', parts: pieces.map(p => p.text), truncated: !full,
    sourceLoss: known ? [] : ['Original byte length not measured: source exceeds bounded scan; UTF-16 length and retained ranges are exact.'] };
}
interface Loss { path: string; reason: string; text?: Omit<TextSlice, 'parts'> }
interface Captured { content: unknown; losses: Loss[] }
interface SemanticFlags { sourceUnavailable: boolean; identityAmbiguous: boolean; resultUnavailable: boolean }
export interface UploadIntegrity extends SemanticFlags {
  obligations: number;
  completedResults: number;
  unresolvedResults: number;
  lateResults: number;
  lateOriginsOverflow: boolean;
}
const semanticFlags = (): SemanticFlags => ({ sourceUnavailable: false, identityAmbiguous: false, resultUnavailable: false });
/** These facts are collected before projection/fitting, never inferred from bounded
 * explanatory strings. Deliberate traversal/media/byte omissions are not failures. */
function sourceOwn(value: unknown, key: string, flags: SemanticFlags): unknown {
  const property = value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
  if (!property || !('value' in property)) { flags.sourceUnavailable = true; return undefined; }
  return property.value;
}
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
function snapshot(value: unknown, flags = semanticFlags()): Snapshot {
  let nodes = 0;
  const visit = (item: unknown, depth: number, ceiling = 128): Snapshot => {
    if (nodes >= ceiling || depth > 8) return omitted('Traversal budget: entire region omitted');
    nodes++;
    if (typeof item === 'string') return { text: sliceText(item, MAX_ACTION_BYTES) };
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return { scalar: item };
    if (typeof item !== 'object' || ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return omitted('Binary or non-JSON value omitted');
    const kind = own(item, 'type');
    const sdkMedia = ['imageBlock', 'audioBlock', 'videoBlock', 'documentBlock'].includes(kind as string) && own(item, 'source') !== undefined;
    const mcpMedia = (kind === 'image' || kind === 'audio') && typeof own(item, 'data') === 'string' && typeof own(item, 'mimeType') === 'string';
    if (sdkMedia || mcpMedia) return omitted('Structured media payload omitted');
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
      const property = Object.getOwnPropertyDescriptor(item, key);
      const unavailable = !property || !('value' in property);
      if (unavailable) flags.sourceUnavailable = true;
      if (key.length > 128) { losses.push({ path: '', reason: 'Oversized property name and its value omitted' }); continue; }
      entries.push([key, unavailable ? omitted('Accessor or absent own value omitted without evaluation') : visit(property.value, depth + 1, ceiling - (keys.length - index - 1))]);
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
  const clip = (text: string, cap: number, tail: boolean) => clipText(text,
    tail ? Math.max(0, text.length - cap) : 0, tail ? text.length : Math.min(text.length, cap), cap, tail).text;
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

type Result = { status: string; evidence: string; exitCode?: number; content: Captured };
type Origin = { turn: number; ordinal: number; invocation: string; invocationScope: number; tool: string };
type Action = { ordinal: number; invocation: string; invocationScope: number; attempt: number; tool: string; inputSource: string; input: Captured; result: Result | { missing: string }; acknowledgement?: Result; original?: Origin; failed: boolean; recovery: boolean; sourceLoss: string[] };
type Summary = Pick<Action, 'ordinal' | 'invocation' | 'invocationScope' | 'tool' | 'failed' | 'recovery' | 'original'> & { status: string; exitCode?: number; bodyOmitted: true };
type Call = { action?: Action; summary?: Summary; ordinal: number; attempt: number; started: boolean; ambiguous: boolean; unresolved: number; observed?: boolean; acknowledged?: boolean };
type LateAction = Action & { integrity: Readonly<SemanticFlags> };
function summary(action: Action): Summary {
  return { ordinal: action.ordinal, invocation: action.invocation, invocationScope: action.invocationScope, tool: action.tool, failed: action.failed, recovery: action.recovery, status: 'status' in action.result ? action.result.status : action.result.missing,
    ...('exitCode' in action.result ? { exitCode: action.result.exitCode } : {}), ...(action.original ? { original: action.original } : {}), bodyOmitted: true };
}
function priority(action: Action | Summary): number { return action.failed || action.recovery ? 1 : 0; }
function comparePriority(a: Action | Summary, b: Action | Summary): number { return priority(a) - priority(b) || a.ordinal - b.ordinal; }
function toolText(content: unknown, flags: SemanticFlags): { value: unknown[]; loss: string[]; exitCode?: number } {
  const value: unknown[] = []; const loss = new Set<string>(); let exitCode: number | undefined;
  if (!Array.isArray(content)) { flags.resultUnavailable = true; return { value, loss: ['SDK result content unavailable'] }; }
  const length = own(content, 'length') as number;
  value.length = length;
  for (const i of indices(length)) {
    // An explicit placeholder for every selected index: deliberately excluded
    // media must not become an absent descriptor when snapshot visits this array.
    value[i] = null;
    const block = sourceOwn(content, String(i), flags);
    const kind = sourceOwn(block, 'type', flags);
    if (kind === 'textBlock') {
      const text = sourceOwn(block, 'text', flags);
      if (typeof text === 'string') {
        value[i] = { text };
        if (/\[.*(?:offload|truncat)|truncated:|retrieve_offloaded_content/i.test(text.slice(0, 1024))) loss.add('SDK text signals possible upstream truncation/offload; not hydrated');
        continue;
      }
      flags.resultUnavailable = true;
    } else if (kind === 'jsonBlock') {
      const json = sourceOwn(block, 'json', flags); value[i] = { json };
      const code = own(json, 'exitCode');
      if (typeof code === 'number' && Number.isInteger(code)) exitCode = code;
      continue;
    }
    loss.add('Non-text/JSON SDK block or accessor omitted without evaluation (binary/image or unsupported)');
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
  private calls = new Map<string, Call>();
  private inputs = new WeakMap<Action, Snapshot>();
  private outputs = new WeakMap<Action, Snapshot>();
  private readonly flags = semanticFlags();
  private obligations = 0;
  private completedResults = 0;
  // Untrackable obligations (and, after finish, every remaining ledger obligation).
  private sealedUnresolved = 0;
  private finished = false;
  private lateResults = 0;
  private readonly originTurns = new Set<number>();
  private lateOriginsOverflow = false;
  get integrity(): Readonly<UploadIntegrity> {
    let unresolvedResults = this.sealedUnresolved;
    for (const call of this.calls.values()) unresolvedResults += call.unresolved;
    return Object.freeze({ ...this.flags, obligations: this.obligations, completedResults: this.completedResults,
      unresolvedResults, lateResults: this.lateResults, lateOriginsOverflow: this.lateOriginsOverflow });
  }
  /** Controller provenance must check every copied original turn, not the retained
   * action window. Overflow fails closed; this never retains bodies or SDK state. */
  lateOrigins(): { turns: readonly number[]; overflow: boolean } {
    return { turns: [...this.originTurns], overflow: this.lateOriginsOverflow };
  }
  private mergeFlags(flags: Readonly<SemanticFlags>): void {
    this.flags.sourceUnavailable ||= flags.sourceUnavailable;
    this.flags.identityAmbiguous ||= flags.identityAmbiguous;
    this.flags.resultUnavailable ||= flags.resultUnavailable;
  }
  totalActions = 0;
  internalEvents = 0;
  batchEntriesOmitted = 0;
  unmatchedResults = 0;
  resultsWithoutSummary = 0;
  backgroundResultsDropped = 0;
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
    const value = summary(action);
    this.summaries.push(value);
    const record = this.calls.get(`${action.invocationScope}:${action.invocation}`);
    if (record?.action === action) { delete record.action; record.summary = value; }
    if (this.summaries.length > MAX_SUMMARIES) {
      const evicted = this.summaries.shift()!;
      const old = this.calls.get(`${evicted.invocationScope}:${evicted.invocation}`);
      if (old?.summary === evicted) delete old.summary;
      this.aggregatedActions++;
    }
  }
  before(event: BeforeToolCallEvent): void { this.add(event.toolUse, event.invocationState, true); }
  private add(use: unknown, state: object, started: boolean): void {
    if (this.finished) return;
    const rawId = sourceOwn(use, 'toolUseId', this.flags); const name = sourceOwn(use, 'name', this.flags);
    const validId = typeof rawId === 'string' && rawId.length > 0 && rawId.length <= 256;
    const id = validId ? rawId : `unavailable-${this.totalActions + 1}`;
    const key = this.key(state, id, true)!;
    const prior = validId ? this.calls.get(key) : undefined;
    // Intent is not a second attempt, even after both retention windows evict it.
    // Completed/reused IDs otherwise lack a public attempt token: refuse pairing.
    const intent = started && prior !== undefined && !prior.started && !prior.ambiguous && !prior.observed;
    const retainedIntent = intent ? prior.action : undefined;
    const ordinal = intent ? prior.ordinal : ++this.totalActions;
    if (!intent) this.obligations++;
    const input = snapshot(sourceOwn(use, 'input', this.flags), this.flags);
    const action: Action = retainedIntent ?? { ordinal, invocation: id, invocationScope: this.scopes.get(state)!, attempt: intent ? prior.attempt : (prior?.attempt ?? 0) + 1,
      tool: '', inputSource: '', input: project(input), result: { missing: 'No corresponding result observed (cancelled, incomplete or still pending)' }, failed: false, recovery: this.lastFailed, sourceLoss: [] };
    action.tool = typeof name === 'string' ? sliceText(name, 256).parts.join('') : '(unavailable)';
    action.inputSource = started ? 'BeforeToolCall execution input' : 'BeforeTools requested input; execution not observed';
    action.input = project(input);
    if (!validId) action.sourceLoss.push('Oversized/missing SDK identity omitted; corresponding result cannot be matched');
    if (typeof name === 'string' && (name.length > 512 || Buffer.byteLength(name.slice(0, 512)) > 256)) action.sourceLoss.push('Tool name head/tail truncated to 256 bytes');
    this.lastFailed = false;
    if (!intent && prior) {
      this.flags.identityAmbiguous = true;
      action.sourceLoss.push('SDK ID reused within invocation state; result attribution refused');
      action.result = { missing: 'Ambiguous reused SDK ID; result attribution refused' };
      if (prior.action && 'missing' in prior.action.result) prior.action.result.missing = 'Ambiguous reused SDK ID; result attribution refused';
      if (prior.summary && !prior.observed) prior.summary.status = 'Ambiguous reused SDK ID; result attribution refused';
      this.pending.delete(key);
    }
    // Keep identity tombstones even for evicted actions. Once full, never forget
    // identities and risk attaching a delayed result to a reused ID.
    const track = validId && (prior !== undefined || this.calls.size < 512);
    if (!track) {
      this.flags.identityAmbiguous = true; this.sealedUnresolved++;
      action.sourceLoss.push('Identity ledger unavailable/full (512 keys); results remain unmatched');
      action.result = { missing: 'Identity unavailable/full; observed results cannot be safely attributed' };
    }
    if (track) {
      this.calls.set(key, { action, ordinal, attempt: action.attempt, started, ambiguous: !intent && prior !== undefined || prior?.ambiguous === true,
        unresolved: (prior?.unresolved ?? 0) + (intent ? 0 : 1) });
      if (!this.calls.get(key)!.ambiguous) this.pending.set(key, action);
    }
    if (intent && prior.summary) this.summaries.splice(this.summaries.indexOf(prior.summary), 1);
    UploadTurn.fitAction(action, input);
    this.inputs.set(action, input);
    if (!retainedIntent) this.actions.push(action);
    this.actions.sort((a, b) => a.ordinal - b.ordinal); this.boundActions();
  }
  private boundActions(): void {
    if (this.actions.length > MAX_ACTIONS) {
      const candidates = this.actions.slice(0, -16);
      const victim = candidates.reduce((a, b) => comparePriority(a, b) < 0 ? a : b);
      this.actions.splice(this.actions.indexOf(victim), 1);
      const victimKey = `${victim.invocationScope}:${victim.invocation}`;
      if (this.pending.get(victimKey) === victim) this.pending.delete(victimKey);
      this.inputs.delete(victim); this.outputs.delete(victim); this.omit(victim);
    }
  }
  private static fitAction(action: Action, input: Snapshot, result?: Snapshot): void {
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
  fallback(event: ToolResultEvent): Origin | undefined {
    return this.result(event.invocationState, event.result, 'observed public ToolResultEvent fallback; no pre-after-hook snapshot available', true);
  }
  private result(state: object, result: unknown, evidence: string, fallback = false): Origin | undefined {
    if (this.finished) return;
    const id = sourceOwn(result, 'toolUseId', this.flags);
    const key = typeof id === 'string' && id.length > 0 && id.length <= 256 ? this.key(state, id) : undefined;
    const record = key === undefined ? undefined : this.calls.get(key);
    if (!record || record.ambiguous) { this.flags.identityAmbiguous = true; this.unmatchedResults++; return; }
    let action = record.action;
    const flags = semanticFlags();
    const text = toolText(sourceOwn(result, 'content', flags), flags);
    const status = sourceOwn(result, 'status', flags);
    if (status !== 'success' && status !== 'error') flags.resultUnavailable = true;
    const failed = status === 'error' || text.exitCode !== undefined && text.exitCode !== 0;
    const ack = fallback && status === 'success' && indices(text.value.length).some(index => {
      const value = own(text.value[index], 'text');
      return typeof value === 'string' && value.startsWith('Background task dispatched.\n\nTask ID: ') && /^Task ID: \S{1,256}$/mu.test(value.slice(0, 1024));
    });
    const retained = action ?? record.summary;
    if (ack) {
      if (record.acknowledged) return;
      record.acknowledged = true;
      const captured = snapshot(text.value, flags); this.mergeFlags(flags);
      if (!retained) { this.resultsWithoutSummary++; return; }
      if (action && !action.acknowledgement) {
        action.acknowledgement = { status: 'acknowledged', evidence, content: fit(captured, 1024) };
        if (!record.observed) action.result = { missing: 'Background acknowledged; final result pending' };
        UploadTurn.fitAction(action, this.inputs.get(action) ?? snapshot(null), this.outputs.get(action));
      } else if (record.summary && !record.observed) record.summary.status = 'Background acknowledged; final result pending (body omitted)';
      if (!record.observed) return { turn: this.turn, ordinal: retained.ordinal, invocation: retained.invocation, invocationScope: retained.invocationScope, tool: retained.tool };
      return;
    }
    if (record.observed) return;
    record.observed = true;
    // Traverse even when neither body nor summary survives. A matched arrival
    // resolves its obligation once; unavailable evidence remains a separate flag.
    const captured = snapshot(text.value, flags); this.mergeFlags(flags);
    record.unresolved = 0;
    if (status === 'success' || status === 'error') this.completedResults++;
    if (record.summary) {
      Object.assign(record.summary, { status: status === 'error' || status === 'success' ? status : 'not reported', failed,
        ...(text.exitCode === undefined ? {} : { exitCode: text.exitCode }) });
      // Recover failure text when the input body was evicted, without pretending
      // the omitted input is still present. Selection may evict another body.
      if (failed) {
        const old = record.summary;
        this.summaries.splice(this.summaries.indexOf(old), 1); delete record.summary;
        const { bodyOmitted: _omitted, status: _status, exitCode: _exit, ...identity } = old;
        action = { ...identity, attempt: record.attempt, inputSource: 'Input body evicted before result', input: { content: null, losses: [{ path: '', reason: 'Input body omitted for capacity' }] }, result: { missing: '' }, sourceLoss: ['Input body omitted for capacity before result arrived'] };
        record.action = action; this.actions.push(action);
      }
    } else if (!action) this.resultsWithoutSummary++;
    this.lastFailed = failed;
    this.pending.delete(key!);
    if (!action) return;
    action.result = { status: status === 'success' || status === 'error' ? status : 'not reported', evidence,
      ...(text.exitCode === undefined ? {} : { exitCode: text.exitCode }), content: project(captured) };
    action.sourceLoss.push(...text.loss); action.failed = failed;
    UploadTurn.fitAction(action, this.inputs.get(action) ?? snapshot(null), captured);
    this.outputs.set(action, captured);
    this.actions.sort((a, b) => a.ordinal - b.ordinal); this.boundActions();
  }
  static late(original: Origin, result: unknown): LateAction {
    const flags = semanticFlags();
    const text = toolText(sourceOwn(result, 'content', flags), flags); const captured = snapshot(text.value, flags);
    const status = sourceOwn(result, 'status', flags);
    if (status !== 'success' && status !== 'error') flags.resultUnavailable = true;
    const action: LateAction = { integrity: Object.freeze(flags), ordinal: Number.MAX_SAFE_INTEGER, invocation: original.invocation, invocationScope: 0, attempt: 1, tool: original.tool,
      original: { ...original }, inputSource: 'Late background result; input belongs to original turn/invocation', input: { content: null, losses: [] },
      result: { status: status === 'success' || status === 'error' ? status : 'not reported', evidence: 'pre-after-hook background execution evidence; received via ordinary parent forwarding', content: project(captured), ...(text.exitCode === undefined ? {} : { exitCode: text.exitCode }) },
      failed: status === 'error' || text.exitCode !== undefined && text.exitCode !== 0, recovery: false, sourceLoss: text.loss };
    UploadTurn.fitAction(action, snapshot(null), captured);
    return action;
  }
  receiveLate(action: LateAction): void {
    if (this.finished) return;
    this.mergeFlags(action.integrity);
    this.obligations++; this.lateResults++;
    if ('status' in action.result && (action.result.status === 'success' || action.result.status === 'error')) this.completedResults++;
    if (action.original && !this.originTurns.has(action.original.turn)) {
      if (this.originTurns.size < 64) this.originTurns.add(action.original.turn);
      else this.lateOriginsOverflow = true;
    }
    this.actions.push({ ...action, ordinal: ++this.totalActions }); this.boundActions();
  }
  finish(): void {
    if (this.finished) return;
    this.sealedUnresolved = this.integrity.unresolvedResults; this.finished = true;
    this.pending.clear(); this.calls.clear(); this.inputs = new WeakMap(); this.outputs = new WeakMap(); this.scopes = new WeakMap();
  }
}

/** Parent-only pre-after-hook execution capture plus public-result fallback.
 * No I/O, async work, Agent/event serialization, model calls or SDK mutation. */
export class UploadObserver {
  private active: UploadTurn | undefined;
  private turns = new Map<number, UploadTurn>();
  private invocations = new WeakMap<object, { turn: number; scope: number }>();
  private scope = 0;
  // Weak state keys never retain Agent/invocation graphs. Only bounded copied
  // origins (64) and original result bodies (16 x 8KiB) survive a sealed turn.
  private background = new Map<string, { original: Origin; ready?: LateAction }>();
  private seenAfter = new WeakSet<object>();
  private closed = false;
  private cancelledBackground = new Set<string>();
  private cancelled = false;
  droppedTurns = 0;
  droppedBackground = 0;
  get retainedTurns(): number { return this.turns.size; }
  get pendingBackground(): number { return this.background.size; }
  private register(state: object, turn: UploadTurn): void {
    if (!this.invocations.has(state)) this.invocations.set(state, { turn: turn.turn, scope: ++this.scope });
  }
  private backgroundKey(state: object, id: unknown): string | undefined {
    const scope = this.invocations.get(state)?.scope;
    return scope === undefined || typeof id !== 'string' || id.length > 256 ? undefined : `${scope}:${id}`;
  }
  batch(event: BeforeToolsEvent): void { this.safely(turn => { this.register(event.invocationState, turn); turn.batch(event); }); }
  before(event: BeforeToolCallEvent): void {
    this.safely(turn => {
      this.register(event.invocationState, turn);
      const key = this.backgroundKey(event.invocationState, own(event.toolUse, 'toolUseId'));
      if (key && this.background.delete(key)) { this.droppedBackground++; turn.backgroundResultsDropped++; }
      turn.before(event);
    });
  }
  fallback(event: ToolResultEvent): void {
    this.safely(turn => {
      if (this.invocations.get(event.invocationState)?.turn !== turn.turn) { turn.unmatchedResults++; return; }
      const original = turn.fallback(event);
      const key = this.backgroundKey(event.invocationState, own(event.result, 'toolUseId'));
      if (original && key && !this.background.has(key)) {
        if (this.cancelled || this.background.size >= 64) { this.droppedBackground++; turn.backgroundResultsDropped++; }
        else this.background.set(key, { original });
      }
    });
  }
  after(event: AfterToolCallEvent): void {
    if (this.closed || this.seenAfter.has(event)) return;
    this.seenAfter.add(event);
    try {
      const key = this.backgroundKey(event.invocationState, own(event.result, 'toolUseId'));
      if (key && this.cancelledBackground.has(key)) return;
      const entry = key === undefined ? undefined : this.background.get(key);
      if (this.active && this.invocations.get(event.invocationState)?.turn === this.active.turn) {
        this.active.after(event);
        if (key) this.background.delete(key);
      } else if (entry && !entry.ready) {
        if ([...this.background.values()].filter(value => value.ready).length >= 16) {
          this.background.delete(key!); this.droppedBackground++;
          if (this.active) this.active.backgroundResultsDropped++;
        } else entry.ready = UploadTurn.late(entry.original, event.result);
      } else if (!entry && this.active) this.active.unmatchedResults++;
    } catch { if (this.active) this.active.observerErrors++; else this.droppedBackground++; }
  }
  /** Called only for ordinary parent-stream After events, including the existing
   * background forwarder. Hook-time capture is original; forwarding authorizes
   * inclusion in this turn, never an idle upload or a synthetic USER goal. */
  forwarded(event: AfterToolCallEvent): void {
    if (this.closed) return;
    try {
      const key = this.backgroundKey(event.invocationState, own(event.result, 'toolUseId'));
      const entry = key === undefined ? undefined : this.background.get(key);
      if (!entry?.ready) return;
      if (this.active) this.active.receiveLate(entry.ready);
      else this.droppedBackground++; // A refused collector turn cannot replay forwarding.
      this.background.delete(key!);
    } catch { if (this.active) this.active.observerErrors++; else this.droppedBackground++; }
  }
  private safely(observe: (turn: UploadTurn) => void): void {
    if (this.closed || !this.active) return;
    try { observe(this.active); } catch { this.active.observerErrors++; }
  }
  begin(turn: number, goal: string): void {
    if (this.closed) return;
    this.end(); this.cancelled = false; this.cancelledBackground.clear();
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
  cancel(): void {
    this.droppedBackground += this.background.size;
    if (this.active) this.active.backgroundResultsDropped += this.background.size;
    for (const key of this.background.keys()) this.cancelledBackground.add(key);
    this.background.clear(); this.cancelled = true;
  }
  clear(): void { this.end(); this.turns.clear(); this.cancel(); this.invocations = new WeakMap(); this.cancelledBackground.clear(); }
  close(): void { this.clear(); this.closed = true; }
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
    const quality = { integrity: turn.integrity, completeActions: selected.filter(a => 'status' in a.result).length, missingResults: selected.filter(a => 'missing' in a.result).length,
      contentTruncatedActions: selected.filter(a => a.input.losses.length || 'content' in a.result && a.result.content.losses.length).length,
      sourceLimitedActions: selected.filter(a => a.sourceLoss.length || a.input.losses.some(l => l.text?.sourceLoss.length) || 'content' in a.result && a.result.content.losses.some(l => l.text?.sourceLoss.length)).length,
      actionBodiesOmitted: turn.totalActions - selected.length, actionSummariesOmitted: turn.totalActions - selected.length - summaries.length,
      internalEventsExcluded: turn.internalEvents, batchEntriesOmitted: turn.batchEntriesOmitted, unmatchedResults: turn.unmatchedResults, resultsWithoutSummary: turn.resultsWithoutSummary, backgroundResultsDropped: turn.backgroundResultsDropped, observerErrors: turn.observerErrors };
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
  return `goal ${source.goal.present ? 'present' : 'absent'}${source.goal.truncated ? ' (truncated)' : ''}; ${q.completeActions} complete actions; ${q.missingResults} missing results; ${q.contentTruncatedActions} content-truncated; ${q.actionBodiesOmitted} action bodies omitted; ${q.sourceLimitedActions} source-limited; task success not inferred${q.integrity ? `; turn integrity ${JSON.stringify(q.integrity)}` : ''}`;
}

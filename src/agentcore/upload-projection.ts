import type { AfterToolCallEvent, BeforeToolCallEvent } from '@strands-agents/sdk';
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
/** Text/JSON only, no toJSON(), getters, recursive SDK serialization or hydration.
 * At most 128 visited values, depth 8, 32 entries/container; four detailed losses
 * plus an aggregate. Plain JSON enumeration uses the engine's property iterator.
 * Work on strings is bounded even if SDK hands us a multi-gigabyte string. */
export function capture(value: unknown, budget = 2400): Captured {
  const losses: Loss[] = []; let nodes = 0; let remaining = Math.min(budget, 1800); let extraLoss = false; let lossBytes = 0;
  const loss = (path: string, reason: string, text?: Omit<TextSlice, 'parts'>) => {
    const entry = { path: sliceText(path, 128).parts.join(''), reason, ...(text ? { text } : {}) };
    const size = bytes(entry);
    if (losses.length < 4 && lossBytes + size <= 1200) { losses.push(entry); lossBytes += size; } else extraLoss = true;
  };
  const visit = (item: unknown, path: string, depth: number): unknown => {
    if (++nodes > 128 || depth > 8 || remaining < 32) { loss(path, 'Traversal/content budget: entire region omitted'); return null; }
    remaining -= 16;
    if (typeof item === 'string') {
      let cut = sliceText(item, Math.max(0, remaining - 16));
      if (bytes(cut.parts) > remaining) cut = sliceText(item, Math.max(0, Math.floor((remaining - 16) / 6)));
      remaining -= bytes(cut.parts);
      if (cut.truncated || cut.sourceLoss.length) { const { parts, ...metadata } = cut; loss(path, 'Exact head/tail; middle omitted', metadata); return parts; }
      return cut.parts[0];
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || ArrayBuffer.isView(item) || item instanceof ArrayBuffer) { loss(path, 'Binary or non-JSON value omitted'); return null; }
    const kind = Object.getOwnPropertyDescriptor(item, 'type');
    if (kind && 'value' in kind && ['imageBlock', 'audioBlock', 'videoBlock', 'documentBlock', 'image', 'audio'].includes(kind.value)) {
      loss(path, 'Structured media payload omitted'); return null;
    }
    if (Array.isArray(item)) {
      const result: unknown[] = []; const count = Math.min(item.length, 32);
      for (let i = 0; i < count && remaining >= 32 && nodes < 128; i++) result.push(visit(item[i], `${path}/${i}`, depth + 1));
      if (result.length < item.length) loss(path, `${item.length - result.length} array entries omitted after index ${result.length - 1}`);
      return result;
    }
    const result: Record<string, unknown> = Object.create(null); let count = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (count >= 32 || remaining < 64 || nodes >= 128) { loss(path, 'Remaining object properties omitted; count not traversed'); break; }
      count++;
      if (key.length > 128) { loss(path, 'Oversized property name and its value omitted'); continue; }
      const keyBytes = bytes(key) + 4;
      if (remaining < keyBytes + 32) { loss(path, 'Property name/value and remaining properties omitted: serialized key budget'); break; }
      remaining -= keyBytes;
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !('value' in property)) { loss(`${path}/${key}`, 'Accessor omitted without evaluation'); continue; }
      result[key] = visit(property.value, `${path}/${key}`, depth + 1);
    }
    return result;
  };
  const content = visit(value, '', 0);
  if (extraLoss) losses.push({ path: '', reason: 'Additional bounded traversal losses aggregated; no omitted region is represented as complete' });
  return { content, losses };
}

type Action = { ordinal: number; invocation: string; tool: string; input: Captured; result: { status: string; exitCode?: number; content: Captured } | { missing: string }; failed: boolean; recovery: boolean; sourceLoss: string[] };
type Summary = Pick<Action, 'ordinal' | 'invocation' | 'tool' | 'failed' | 'recovery'> & { status: string; exitCode?: number; bodyOmitted: true };
function summary(action: Action): Summary {
  return { ordinal: action.ordinal, invocation: action.invocation, tool: action.tool, failed: action.failed, recovery: action.recovery, status: 'status' in action.result ? action.result.status : action.result.missing,
    ...('exitCode' in action.result ? { exitCode: action.result.exitCode } : {}), bodyOmitted: true };
}
function priority(action: Action | Summary): number { return action.failed || action.recovery ? 1 : 0; }
function comparePriority(a: Action | Summary, b: Action | Summary): number { return priority(a) - priority(b) || a.ordinal - b.ordinal; }
function toolText(content: unknown): { value: unknown[]; loss: string[]; exitCode?: number } {
  const value: unknown[] = []; const loss: string[] = []; let exitCode: number | undefined;
  if (!Array.isArray(content)) return { value, loss: ['SDK result content unavailable'] };
  for (let i = 0; i < Math.min(content.length, 32); i++) {
    const block = content[i];
    if (block?.type === 'textBlock' && typeof block.text === 'string') {
      value.push({ text: block.text });
      if (/\[.*(?:offload|truncat)|truncated:|retrieve_offloaded_content/i.test(block.text.slice(0, 1024))) loss.push('SDK text signals possible upstream truncation/offload; not hydrated');
    } else if (block?.type === 'jsonBlock') {
      value.push({ json: block.json });
      if (Number.isInteger(block.json?.exitCode)) exitCode = block.json.exitCode;
    } else loss.push('Non-text/JSON SDK block omitted (binary/image or unsupported)');
  }
  if (content.length > 32) loss.push(`${content.length - 32} SDK content blocks omitted`);
  return { value, loss, ...(exitCode === undefined ? {} : { exitCode }) };
}

export class UploadTurn {
  readonly goal: TextSlice;
  readonly actions: Action[] = [];
  readonly summaries: Summary[] = [];
  readonly pending = new Map<string, Action>();
  totalActions = 0;
  internalEvents = 0;
  unmatchedResults = 0;
  aggregatedActions = 0;
  observerErrors = 0;
  private lastFailed = false;
  constructor(readonly turn: number, goal: string) { this.goal = sliceText(goal, 8192); }
  private omit(action: Action) {
    this.summaries.push(summary(action));
    if (this.summaries.length > MAX_SUMMARIES) { this.summaries.shift(); this.aggregatedActions++; }
  }
  before(event: BeforeToolCallEvent): void {
    const use = event.toolUse;
    const ordinal = ++this.totalActions;
    const id = typeof use.toolUseId === 'string' && use.toolUseId.length <= 256 ? use.toolUseId : `unavailable-${ordinal}`;
    const action: Action = { ordinal, invocation: id, tool: sliceText(use.name, 256).parts.join(''), input: capture(use.input), result: { missing: 'No corresponding result observed (cancelled, incomplete or still pending)' }, failed: false, recovery: this.lastFailed, sourceLoss: [] };
    if (id !== use.toolUseId) action.sourceLoss.push('Oversized/missing SDK identity omitted; ordinal is local identity, corresponding result cannot be matched');
    if (Buffer.byteLength(action.tool) < Buffer.byteLength(use.name.slice(0, 512)) || use.name.length > 512) action.sourceLoss.push('Tool name head/tail truncated to 256 bytes');
    this.lastFailed = false;
    if (this.pending.has(id)) { action.sourceLoss.push('SDK invocation ID reused; ordinal disambiguates attempts'); this.pending.delete(id); }
    this.actions.push(action); this.pending.set(id, action);
    if (this.actions.length > MAX_ACTIONS) {
      // Preserve the newest quarter even when the earlier failure history is long.
      const candidates = this.actions.slice(0, -16);
      const victim = candidates.reduce((a, b) => comparePriority(a, b) < 0 ? a : b);
      this.actions.splice(this.actions.indexOf(victim), 1);
      if (this.pending.get(victim.invocation) === victim) this.pending.delete(victim.invocation);
      this.omit(victim);
    }
  }
  after(event: AfterToolCallEvent): void {
    const id = event.toolUse.toolUseId;
    const action = this.pending.get(id);
    if (!action) { this.unmatchedResults++; return; }
    this.pending.delete(id);
    const text = toolText(event.result.content);
    action.result = { status: event.result.status, ...(text.exitCode === undefined ? {} : { exitCode: text.exitCode }), content: capture(text.value) };
    action.sourceLoss.push(...new Set(text.loss));
    action.failed = event.result.status === 'error' || text.exitCode !== undefined && text.exitCode !== 0;
    this.lastFailed = action.failed;
    // Re-project from original data, never truncate an already-truncated projection:
    // retained ranges must continue to name the actual source, not the previous cut.
    if (bytes(action) > MAX_ACTION_BYTES) {
      action.input = capture(event.toolUse.input, 600);
      action.result.content = capture(text.value, 600);
      action.sourceLoss.push('Per-side content budget reduced for full-action metadata/JSON escaping');
    }
  }
  finish(): void { this.pending.clear(); }
}

/** Parent-only SDK hooks registered before ContextOffloader. No I/O or async work,
 * serialization of Agent/events, model calls or changes to SDK objects. */
export class UploadObserver {
  private active: UploadTurn | undefined;
  private turns = new Map<number, UploadTurn>();
  private invocations = new WeakMap<object, number>();
  droppedTurns = 0;
  get retainedTurns(): number { return this.turns.size; }
  before(event: BeforeToolCallEvent): void { this.safely(turn => { this.invocations.set(event.invocationState, turn.turn); turn.before(event); }); }
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
      internalEventsExcluded: turn.internalEvents, unmatchedResults: turn.unmatchedResults, observerErrors: turn.observerErrors };
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

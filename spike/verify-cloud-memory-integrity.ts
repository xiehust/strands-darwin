/** Finding A: semantic integrity survives bounded projection and retention.
 * Offline, in-memory only: real SDK events/blocks, descriptors installed AFTER
 * construction. No model invocation, cloud/config/files or existing suite edits.
 * Run: pnpm tsx spike/verify-cloud-memory-integrity.ts. */
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
process.env['AWS_EC2_METADATA_DISABLED'] = 'true';
import { Agent, BeforeToolCallEvent, AfterToolCallEvent, BeforeToolsEvent, ToolResultEvent, ToolUseBlock, ToolResultBlock, TextBlock, JsonBlock, ImageBlock, Message } from '@strands-agents/sdk';
import { autoHoldReason } from '../src/agentcore/auto-policy.js';
import { UploadTurn, UploadObserver, uploadBody, uploadQuality, MAX_ACTION_BYTES, MAX_EVENT_BYTES, type UploadIntegrity } from '../src/agentcore/upload-projection.js';
import { assert, header, report } from './shared.js';

const agent = new Agent({ model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', printer: false });
const state = {};
const settlement = { durable: true as const, session: 'synthetic-integrity', turn: 1, seq: 99, at: '2026-01-01T00:00:00Z', stopReason: 'endTurn', failure: false, partial: false };
const envelope = { memoryId: 'Synthetic-0123456789', actorId: 'synthetic-user', sessionId: settlement.session, eventTimestamp: settlement.at, clientToken: 'a'.repeat(64), extractionConfig: { namespaceVariables: { projectid: 'synthetic' } } };
function events(id: string, input: object = {}, content: ToolResultBlock['content'] = [new TextBlock('ok')], invocationState = state) {
  const use = new ToolUseBlock({ name: 'arbitrary_secret_mcp', toolUseId: id, input: input as ToolUseBlock['input'] });
  return [new BeforeToolCallEvent({ agent, invocationState, tool: undefined, toolUse: use }),
    new AfterToolCallEvent({ agent, invocationState, tool: undefined, toolUse: use, result: new ToolResultBlock({ toolUseId: id, status: 'success', content }) })] as const;
}
type Pair = ReturnType<typeof events>;
const add = (turn: UploadTurn, pair: Pair) => { turn.before(pair[0]); turn.after(pair[1]); };
function clean(turn: UploadTurn, count: number, prefix = 'clean') { for (let i = 0; i < count; i++) add(turn, events(`${prefix}-${i}`)); }
let getterCalls = 0;
function accessor(value: object, key: string) {
  Object.defineProperty(value, key, { enumerable: true, configurable: true, get() { getterCalls++; throw new Error('getter must not execute'); } });
}
function hidden(turn: UploadTurn, id: string) { return !turn.actions.some(a => a.invocation === id) && !turn.summaries.some(a => a.invocation === id); }
function check(turn: UploadTurn, label: string, held: boolean, expected: Partial<UploadIntegrity> = {}) {
  const q = turn.integrity;
  assert(`${label}: eligibility`, (autoHoldReason(turn, settlement) !== undefined) === held);
  assert(`${label}: exact semantic state`, Object.entries(expected).every(([key, value]) => q[key as keyof UploadIntegrity] === value));
  const body = uploadBody(envelope, turn, settlement)!;
  const text = body.payload[0]!.conversational.content.text;
  assert(`${label}: payload and preview agree`, JSON.stringify(JSON.parse(text).quality.integrity) === JSON.stringify(q) && uploadQuality(text).includes(`turn integrity ${JSON.stringify(q)}`));
  assert(`${label}: all caps`, turn.actions.length <= 64 && turn.summaries.length <= 96 && turn.pending.size <= 64 &&
    turn.actions.every(a => Buffer.byteLength(JSON.stringify(a)) <= MAX_ACTION_BYTES) && Buffer.byteLength(JSON.stringify(body)) <= MAX_EVENT_BYTES &&
    body.payload.length <= 100 && body.payload.every(p => Buffer.byteLength(p.conversational.content.text) <= 100000));
}

header('Source integrity survives both retention windows');
for (const whole of [false, true]) {
  const turn = new UploadTurn(1, 'goal'); const pair = events('accessor');
  if (whole) accessor(pair[0].toolUse, 'input'); else accessor(pair[0].toolUse.input as object, 'nested');
  add(turn, pair);
  check(turn, `input accessor whole=${whole} initially`, true, { sourceUnavailable: true, obligations: 1, completedResults: 1, unresolvedResults: 0 });
  clean(turn, 64); check(turn, `input accessor whole=${whole} after 64`, true, { sourceUnavailable: true });
  assert('accessor action body really evicted', !turn.actions.some(a => a.invocation === 'accessor'));
  clean(turn, 96, 'more');
  assert('accessor summary really evicted', hidden(turn, 'accessor'));
  turn.finish(); check(turn, `input accessor whole=${whole} after 160 and finish`, true, { sourceUnavailable: true, obligations: 161, completedResults: 161, unresolvedResults: 0 });
}

header('Obligations outlive bodies; valid delayed completion resolves exactly once');
for (const resolve of [false, true]) {
  const turn = new UploadTurn(1, 'goal'); const pair = events('pending'); turn.before(pair[0]);
  check(turn, 'pending initially', true, { obligations: 1, unresolvedResults: 1, completedResults: 0 });
  clean(turn, 160); assert('unresolved action and summary really evicted', hidden(turn, 'pending'));
  check(turn, 'pending after 160', true, { obligations: 161, unresolvedResults: 1, completedResults: 160 });
  if (resolve) {
    turn.after(pair[1]); turn.after(pair[1]);
    turn.fallback(new ToolResultEvent({ agent, invocationState: state, result: pair[1].result }));
    assert('evicted result counted once with no unmatched event', turn.resultsWithoutSummary === 1 && turn.unmatchedResults === 0);
  }
  turn.finish(); const sealed = JSON.stringify(turn.integrity); turn.finish(); turn.after(pair[1]);
  assert('finish idempotent and sealed turn immutable', JSON.stringify(turn.integrity) === sealed);
  check(turn, `sealed resolve=${resolve}`, !resolve, { unresolvedResults: resolve ? 0 : 1, completedResults: resolve ? 161 : 160 });
}
const parallel = new UploadTurn(1, 'parallel'); const parallelPairs = Array.from({ length: 240 }, (_, i) => events(`parallel-${i}`));
for (const pair of parallelPairs) parallel.before(pair[0]);
check(parallel, '240 parallel pending', true, { obligations: 240, unresolvedResults: 240 });
for (const pair of parallelPairs) { parallel.after(pair[1]); parallel.after(pair[1]); }
check(parallel, '240 parallel complete', false, { obligations: 240, completedResults: 240, unresolvedResults: 0 });
parallel.finish(); check(parallel, '240 complete sealed', false, { unresolvedResults: 0 });
for (const completedFirst of [false, true]) {
  const turn = new UploadTurn(1, 'reuse'); const pair = events('reused');
  turn.before(pair[0]); if (completedFirst) turn.after(pair[1]); turn.before(pair[0]);
  clean(turn, 160); turn.finish();
  assert('duplicate IDs held even without ANY unmatched-result event', turn.unmatchedResults === 0 && hidden(turn, 'reused'));
  check(turn, `reuse completedFirst=${completedFirst}`, true, { identityAmbiguous: true, obligations: 162, unresolvedResults: completedFirst ? 1 : 2 });
}
for (const identity of ['absent', 'accessor', 'empty', 'oversized'] as const) {
  const turn = new UploadTurn(1, 'identity'); const pair = events('identity');
  if (identity === 'accessor') accessor(pair[0].toolUse, 'toolUseId');
  else if (identity === 'absent') Reflect.deleteProperty(pair[0].toolUse, 'toolUseId');
  else Object.defineProperty(pair[0].toolUse, 'toolUseId', { value: identity === 'empty' ? '' : 'i'.repeat(257) });
  turn.before(pair[0]); clean(turn, 160); turn.finish();
  assert('missing identity needs no result to hold', turn.unmatchedResults === 0);
  check(turn, `identity ${identity}`, true, { identityAmbiguous: true, obligations: 161, unresolvedResults: 1 });
}
const saturated = new UploadTurn(1, 'ledger'); clean(saturated, 512);
check(saturated, '512 complete at ledger bound', false, { completedResults: 512, unresolvedResults: 0, identityAmbiguous: false });
saturated.before(events('overflow')[0]);
assert('identity ledger remains capped at 512', (saturated as unknown as { calls: Map<string, unknown> }).calls.size === 512);
// Turn-local ledger is saturated, so use copied complete late
// results to evict that missing action without adding more failed identities.
for (let i = 0; i < 160; i++) saturated.receiveLate(UploadTurn.late({ turn: 0, ordinal: i + 1, invocation: `late-${i}`, invocationScope: 1, tool: 'arbitrary' }, events(`late-${i}`)[1].result));
assert('ledger-overflow action and summary really evicted', hidden(saturated, 'overflow'));
saturated.finish();
check(saturated, 'ledger overflow WITHOUT result', true, { identityAmbiguous: true, obligations: 673, completedResults: 672, unresolvedResults: 1 });
assert('ledger overflow does not require unmatched evidence', saturated.unmatchedResults === 0);
const intent = new UploadTurn(1, 'batch'); const requested = events('requested');
intent.batch(new BeforeToolsEvent({ agent, invocationState: state, message: new Message({ role: 'assistant', content: [new ToolUseBlock(requested[0].toolUse)] }) }));
clean(intent, 160); intent.before(requested[0]); intent.after(requested[1]); intent.finish();
check(intent, 'evicted batch intent is not an extra obligation', false, { obligations: 161, completedResults: 161, unresolvedResults: 0, identityAmbiguous: false });

header('Result discovery before detail caps, fitting and absent bodies');
for (const kind of ['whole', 'nested', 'block-text', 'block-json', 'index', 'status'] as const) {
  for (const evicted of [false, true]) {
    const turn = new UploadTurn(1, 'result'); const pair = events('result', {}, [new TextBlock('ok'), new JsonBlock({ json: { nested: {} } })]);
    const result = pair[1].result;
    if (kind === 'whole') accessor(result, 'content');
    if (kind === 'nested') accessor((result.content[1] as JsonBlock).json as object, 'nested');
    if (kind === 'block-text') accessor(result.content[0]!, 'text');
    if (kind === 'block-json') accessor(result.content[1]!, 'json');
    if (kind === 'index') accessor(result.content, '1');
    if (kind === 'status') accessor(result, 'status');
    turn.before(pair[0]); if (evicted) clean(turn, 160);
    assert(`${kind}: expected body retention at capture`, hidden(turn, 'result') === evicted);
    turn.after(pair[1]); turn.finish();
    check(turn, `${kind} result evicted=${evicted}`, true, { sourceUnavailable: true, unresolvedResults: 0 });
    if (kind === 'whole' || kind === 'status') assert(`${kind}: unavailable flag`, turn.integrity.resultUnavailable);
  }
}
for (const status of [undefined, 'unknown']) {
  const turn = new UploadTurn(1, 'status'); const pair = events('status');
  Object.defineProperty(pair[1].result, 'status', { value: status }); add(turn, pair); clean(turn, 160); turn.finish();
  check(turn, `invalid status ${status}`, true, { resultUnavailable: true, unresolvedResults: 0 });
}
const lossCap = new UploadTurn(1, 'loss cap');
const lossPair = events('loss', Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`large-${i}`, 'x'.repeat(20000)])));
accessor(lossPair[0].toolUse.input as object, 'late-accessor'); add(lossCap, lossPair);
assert('accessor detail actually lost behind loss cap', !lossCap.actions[0]!.input.losses.some(l => /Accessor/.test(l.reason)) && lossCap.actions[0]!.input.losses.length <= 5);
check(lossCap, 'loss-detail cap', true, { sourceUnavailable: true });
const prune = new UploadTurn(1, 'pruning');
const prunePair = events('prune', Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['\u0000'.repeat(120) + i, 'value'])));
accessor(prunePair[0].toolUse.input as object, '\u0000'.repeat(120) + 16); add(prune, prunePair);
assert('fitting actually removed accessor detail', prune.actions[0]!.input.losses.some(l => /Serialized budget/.test(l.reason)) && !prune.actions[0]!.input.losses.some(l => /Accessor/.test(l.reason)));
check(prune, 'pruned accessor', true, { sourceUnavailable: true });
const eventCap = new UploadTurn(1, 'event pruning');
const eventPair = events('first-accessor', { text: '\u0000'.repeat(20000) }); accessor(eventPair[0].toolUse.input as object, 'missing'); add(eventCap, eventPair);
for (let i = 0; i < 63; i++) add(eventCap, events(`large-${i}`, { text: '\u0000'.repeat(20000) }, [new TextBlock('\u0000'.repeat(20000))]));
const rendered = uploadBody(envelope, eventCap, settlement)!;
assert('event-level selection omitted action bodies', JSON.parse(rendered.payload[0]!.conversational.content.text).quality.actionBodiesOmitted > 0);
check(eventCap, 'event selection cannot hide integrity', true, { sourceUnavailable: true });

header('Background copies preserve semantic flags and original turns before eviction');
function acknowledge(observer: UploadObserver, pair: Pair) {
  observer.fallback(new ToolResultEvent({ agent, invocationState: pair[0].invocationState, result: new ToolResultBlock({ toolUseId: pair[0].toolUse.toolUseId, status: 'success', content: [new TextBlock('Background task dispatched.\n\nTask ID: synthetic-task\nTool: arbitrary')] }) }));
}
for (const unavailable of [false, true]) {
  const observer = new UploadObserver(); const pair = events('background', {}, [new JsonBlock({ json: {} })], {});
  observer.begin(1, 'original'); observer.before(pair[0]); acknowledge(observer, pair);
  const original = observer.take(1)!; const originalBody = JSON.stringify(uploadBody(envelope, original, settlement));
  check(original, 'acknowledgement leaves one obligation', true, { unresolvedResults: 1, completedResults: 0 });
  if (unavailable) accessor((pair[1].result.content[0] as JsonBlock).json as object, 'late-accessor');
  observer.after(pair[1]); observer.begin(2, ''); observer.forwarded(pair[1]); observer.forwarded(pair[1]);
  for (let i = 0; i < 160; i++) { const next = events(`recipient-${i}`, {}, undefined, {}); observer.before(next[0]); observer.after(next[1]); }
  const recipient = observer.take(2)!;
  assert('late action and summary evicted, original unchanged', hidden(recipient, 'background') && JSON.stringify(uploadBody(envelope, original, settlement)) === originalBody);
  check(recipient, `late accessor=${unavailable} after 160`, unavailable, { sourceUnavailable: unavailable, lateResults: 1, obligations: 161, completedResults: 161, unresolvedResults: 0 });
  assert('controller provenance interface retains evicted original turn', JSON.stringify(recipient.lateOrigins()) === JSON.stringify({ turns: [1], overflow: false }));
  observer.close();
}
const latePrunePair = events('late-pruned', {}, [new JsonBlock({ json: Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['\u0000'.repeat(120) + i, 'value'])) })]);
accessor((latePrunePair[1].result.content[0] as JsonBlock).json as object, '\u0000'.repeat(120) + 16);
const latePruned = UploadTurn.late({ turn: 1, ordinal: 1, invocation: 'late-pruned', invocationScope: 1, tool: 'arbitrary' }, latePrunePair[1].result);
assert('late semantic copy frozen before fitting removes detail', Object.isFrozen(latePruned.integrity) && latePruned.integrity.sourceUnavailable && 'content' in latePruned.result && !latePruned.result.content.losses.some(l => /Accessor/.test(l.reason)));
const latePrunedTurn = new UploadTurn(2, ''); latePrunedTurn.receiveLate(latePruned); clean(latePrunedTurn, 160); latePrunedTurn.finish();
check(latePrunedTurn, 'late accessor after fitting and both eviction windows', true, { sourceUnavailable: true, lateResults: 1, unresolvedResults: 0 });
const originBound = new UploadTurn(2, 'origins');
for (let i = 0; i < 65; i++) originBound.receiveLate(UploadTurn.late({ turn: i + 1, ordinal: 1, invocation: `original-${i}`, invocationScope: 1, tool: 'arbitrary' }, events(`original-${i}`)[1].result));
clean(originBound, 160); originBound.finish();
check(originBound, 'late-origin overflow fail closed after eviction', true, { lateOriginsOverflow: true, lateResults: 65 });
assert('late-origin provenance set capped at 64, copied not exposed', originBound.lateOrigins().turns.length === 64 && originBound.lateOrigins().turns[0] === 1);
const cancelled = new UploadObserver(); cancelled.begin(1, 'parallel cancellation');
const cancelledPairs = Array.from({ length: 200 }, (_, i) => events(`cancel-${i}`, {}, undefined, {}));
for (const pair of cancelledPairs) cancelled.before(pair[0]);
acknowledge(cancelled, cancelledPairs.at(-1)!); cancelled.cancel();
for (const pair of cancelledPairs.slice(0, 199)) cancelled.after(pair[1]);
cancelled.after(cancelledPairs.at(-1)![1]);
const cancelledTurn = cancelled.take(1)!;
check(cancelledTurn, 'parallel cancellation preserves missing final result', true, { obligations: 200, completedResults: 199, unresolvedResults: 1 });
assert('existing background-drop counter preserved', cancelledTurn.backgroundResultsDropped === 1 && cancelled.droppedBackground === 1);
cancelled.close();
for (const counter of ['observerErrors', 'unmatchedResults', 'backgroundResultsDropped'] as const) {
  const turn = new UploadTurn(1, 'existing counter'); clean(turn, 1); turn[counter]++;
  check(turn, `preserved counter ${counter}`, true);
}

header('Deliberate exclusions and bounded text losses are not severe');
const clearFlags = { sourceUnavailable: false, identityAmbiguous: false, resultUnavailable: false, unresolvedResults: 0 };
for (const content of [
  [new ImageBlock({ format: 'png', source: { bytes: Buffer.from('MEDIA-ONLY') } })],
  [new TextBlock('before'), new ImageBlock({ format: 'png', source: { bytes: Buffer.from('MEDIA-MIDDLE') } }), new TextBlock('after')],
  [new JsonBlock({ json: { type: 'image', data: 'MCP-MEDIA', mimeType: 'image/png' } })],
  [new TextBlock('[Offloaded: retrieve_offloaded_content; truncated: upstream]')],
  [new TextBlock('x'.repeat(300000) + 'EXACT-TAIL')],
  Array.from({ length: 80 }, (_, i) => new TextBlock(`block-${i}`)),
]) {
  const turn = new UploadTurn(1, 'negative'); add(turn, events('negative', { path: '/secret/.env', password: 'eligible text' }, content));
  check(turn, `negative ${content[0]!.type}, blocks=${content.length}`, false, clearFlags);
  assert('media never copied into payload', !JSON.stringify(uploadBody(envelope, turn, settlement)).includes('MEDIA-'));
}
const bounded = new UploadTurn(1, 'huge/traversal');
let deep: object = {}; for (let i = 0; i < 100; i++) deep = { child: deep };
add(bounded, events('bounded', { text: 'x'.repeat(300000), deep, wide: Array.from({ length: 100 }, (_, i) => i), binary: new Uint8Array(100) }, [new TextBlock('\u0000'.repeat(100000))]));
check(bounded, 'all ordinary truncation/unknown-length/budget losses', false, clearFlags);
const longName = new UploadTurn(1, 'name'); const namedPair = events('name');
Object.defineProperty(namedPair[0].toolUse, 'name', { value: 'name'.repeat(1000) }); add(longName, namedPair);
check(longName, 'truncated tool name is not identity ambiguity', false, clearFlags);
const failed = new UploadTurn(1, 'closed failed tool'); const failedPair = events('failed');
Object.defineProperty(failedPair[1].result, 'status', { value: 'error' }); add(failed, failedPair); clean(failed, 180); failed.finish();
check(failed, 'closed failed tool result still eligible', false, { ...clearFlags, obligations: 181, completedResults: 181 });
const sameId = new UploadTurn(1, 'scoped IDs');
for (let i = 0; i < 180; i++) add(sameId, events('same', {}, undefined, {}));
sameId.finish(); check(sameId, '>160 complete across invocation scopes', false, { ...clearFlags, obligations: 180, completedResults: 180 });
const goalOnly = new UploadTurn(1, 'management'); check(goalOnly, 'goal-only has no actual action', true, { obligations: 0, completedResults: 0 });
for (const outcome of [{ failure: true }, { partial: true }, { stopReason: 'cancelled' }]) assert('closure conditions still hold manual', autoHoldReason(sameId, { ...settlement, ...outcome }) !== undefined);
const oldText = JSON.stringify({ format: 'darwin-upload-v2', goal: { present: true }, quality: { completeActions: 1, missingResults: 0, contentTruncatedActions: 0, actionBodiesOmitted: 0, sourceLimitedActions: 0 } });
assert('old immutable manual metadata remains readable without synthetic integrity', !uploadQuality(oldText).includes('integrity') && JSON.parse(oldText).quality.integrity === undefined);
assert('no getters executed anywhere', getterCalls === 0);

report();

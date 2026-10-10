/** Bounded, counter-only application state carried by the SDK session snapshot. */
import type { AppConfig } from '../config.js';
import type { CacheMissCause, CacheMissReport } from './cache-miss.js';
import { emptyCallStats, RECENT_CALL_WINDOW, type SessionCallStats } from './call-stats.js';
import { sumUsage, type UsageTotals } from './usage.js';

export const SESSION_USAGE_KEY = 'darwin.sessionUsage';
const MAX_USAGE_STATE_CHARS = 65_536;
const MAX_USAGE_MODELS = 128;

export interface SessionUsageState {
  version: 1;
  historyComplete: boolean;
  usage: UsageTotals;
  lastTurn?: UsageTotals;
  models: { provider: AppConfig['provider']; model: string; openaiApi?: AppConfig['openaiApi']; usage: UsageTotals }[];
  /** Null preserves a broken observer rather than reviving an incomplete tally. */
  callStats: SessionCallStats | null;
  cacheMisses: CacheMissReport | null;
  children?: { dispatches: number; usage: UsageTotals };
}

/** A rewind's first snapshot has inherited messages but no spend in its new session. */
export function emptySessionUsageState(): SessionUsageState {
  return {
    version: 1, historyComplete: true, usage: { inputTokens: 0, outputTokens: 0 }, models: [],
    callStats: emptyCallStats(), cacheMisses: { misses: 0, lastMiss: undefined },
  };
}

/** Invalid/legacy state costs history, never startup; no guessing from conversation text. */
export function readSessionUsageState(value: unknown): SessionUsageState | undefined {
  try {
    if (JSON.stringify(value)?.length > MAX_USAGE_STATE_CHARS) return undefined;
    const data = object(value);
    if (data?.version !== 1 || typeof data.historyComplete !== 'boolean') return undefined;
    const usage = counters(data.usage);
    const lastTurn = data.lastTurn === undefined ? undefined : counters(data.lastTurn);
    if (usage === undefined || (data.lastTurn !== undefined && lastTurn === undefined)) return undefined;
    if (!Array.isArray(data.models) || data.models.length > MAX_USAGE_MODELS) return undefined;
    const models: SessionUsageState['models'] = [];
    for (const raw of data.models) {
      const entry = object(raw);
      const tokens = counters(entry?.usage);
      if (entry === undefined || tokens === undefined ||
          (entry.provider !== 'bedrock' && entry.provider !== 'anthropic' && entry.provider !== 'openai') ||
          typeof entry.model !== 'string' || entry.model.length === 0 || entry.model.length > 512 ||
          /[\u0000-\u001f\u007f]/u.test(entry.model) ||
          (entry.openaiApi !== undefined && entry.openaiApi !== 'chat' && entry.openaiApi !== 'responses')) return undefined;
      if (models.some((model) => model.provider === entry.provider && model.model === entry.model)) return undefined;
      models.push({
        provider: entry.provider as AppConfig['provider'], model: entry.model, usage: tokens,
        ...(entry.openaiApi === undefined ? {} : { openaiApi: entry.openaiApi as AppConfig['openaiApi'] }),
      });
    }
    // Refuse a checkpoint whose per-model attribution cannot reconcile to its meter.
    const total = sumUsage(models.map((entry) => entry.usage));
    if (!sameCounters(total, usage)) return undefined;
    const callStats = data.callStats === null ? null : stats(data.callStats);
    const cacheMisses = data.cacheMisses === null ? null : misses(data.cacheMisses);
    if (callStats === undefined || cacheMisses === undefined) return undefined;
    let children: SessionUsageState['children'];
    if (data.children !== undefined) {
      const child = object(data.children);
      const tokens = counters(child?.usage);
      if (child === undefined || !count(child.dispatches) || child.dispatches === 0 || tokens === undefined) return undefined;
      children = { dispatches: child.dispatches, usage: tokens };
    }
    return {
      version: 1, historyComplete: data.historyComplete, usage, models, callStats, cacheMisses,
      ...(lastTurn === undefined ? {} : { lastTurn }),
      ...(children === undefined ? {} : { children }),
    };
  } catch {
    return undefined;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function counters(value: unknown): UsageTotals | undefined {
  const data = object(value);
  if (data === undefined || !count(data.inputTokens) || !count(data.outputTokens)) return undefined;
  const result: UsageTotals = { inputTokens: data.inputTokens, outputTokens: data.outputTokens };
  for (const key of ['cacheReadInputTokens', 'cacheWriteInputTokens'] as const) {
    if (data[key] !== undefined) {
      if (!count(data[key])) return undefined;
      result[key] = data[key];
    }
  }
  return result;
}

function sameCounters(left: UsageTotals, right: UsageTotals): boolean {
  return left.inputTokens === right.inputTokens && left.outputTokens === right.outputTokens &&
    left.cacheReadInputTokens === right.cacheReadInputTokens && left.cacheWriteInputTokens === right.cacheWriteInputTokens;
}

function stats(value: unknown): SessionCallStats | undefined {
  const data = object(value);
  if (data === undefined || !count(data.calls) || !count(data.meteredCalls) ||
      !count(data.noTool) || !count(data.singleTool) || !count(data.multiTool) ||
      data.meteredCalls > data.calls || data.noTool + data.singleTool + data.multiTool !== data.calls ||
      !Array.isArray(data.recentToolUseCounts) || data.recentToolUseCounts.length !== Math.min(data.calls, RECENT_CALL_WINDOW) ||
      !data.recentToolUseCounts.every(count)) return undefined;
  const usage = data.usage === undefined ? undefined : counters(data.usage);
  if ((data.usage !== undefined && usage === undefined) ||
      (data.meteredCalls === 0) !== (usage === undefined)) return undefined;
  return {
    calls: data.calls, meteredCalls: data.meteredCalls, usage,
    noTool: data.noTool, singleTool: data.singleTool, multiTool: data.multiTool,
    recentToolUseCounts: [...data.recentToolUseCounts],
  };
}

const CAUSES: readonly CacheMissCause[] = [
  'model switched', 'effort changed', 'compacted', 'idle past cache TTL',
  'first request of a resumed session', 'unknown',
];

function misses(value: unknown): CacheMissReport | undefined {
  const data = object(value);
  if (data === undefined || !count(data.misses)) return undefined;
  if (data.misses === 0) return data.lastMiss === undefined ? { misses: 0, lastMiss: undefined } : undefined;
  const last = object(data.lastMiss);
  if (last === undefined || !CAUSES.includes(last.cause as CacheMissCause) ||
      !count(last.at) || !count(last.cacheRead) || !count(last.requestInput) || last.requestInput === 0) return undefined;
  return { misses: data.misses, lastMiss: {
    cause: last.cause as CacheMissCause, at: last.at, cacheRead: last.cacheRead, requestInput: last.requestInput,
  } };
}

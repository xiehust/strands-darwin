import { tool, type InvokableTool } from '@strands-agents/sdk';
import { z } from 'zod';

import { searchTrajectories, type SearchOutcome } from './search.js';

export const SEARCH_MEMORY_TOOL_NAME = 'search_memory';
export const MAX_MEMORY_QUERY_CHARS = 256;
export const MAX_MEMORY_SESSIONS = 20;
export const MAX_MEMORY_HITS = 10;
export const MAX_MEMORY_RESULT_CHARS = 2_000;

interface SearchMemoryInput {
  query: string;
}

/**
 * Explicit, read-only project recall over the existing append-only trajectory reader.
 * The active session is excluded so the durable input that triggered this call cannot
 * satisfy its own search.
 */
export function createSearchMemoryTool(
  projectRoot: string,
  activeSessionId: string,
  agentId: string,
): InvokableTool<SearchMemoryInput, string> {
  return tool({
    name: SEARCH_MEMORY_TOOL_NAME,
    description:
      'Search prior sessions in this project by case-insensitive literal text. ' +
      'Use this only when earlier project work may answer the current request. ' +
      'Returns bounded source-labelled trajectory excerpts; the active session is excluded. ' +
      'This is read-only textual retrieval, not semantic or vector search.',
    inputSchema: z.object({
      query: z
        .string()
        .refine((value) => value.trim().length > 0, 'query must not be empty')
        .refine(
          (value) => [...value].length <= MAX_MEMORY_QUERY_CHARS,
          `query must contain at most ${MAX_MEMORY_QUERY_CHARS} Unicode code points`,
        )
        .describe('Literal text to find in prior project trajectories'),
    }),
    callback: ({ query }: SearchMemoryInput) => searchMemory(projectRoot, activeSessionId, agentId, query),
  });
}

export async function searchMemory(
  projectRoot: string,
  activeSessionId: string,
  agentId: string,
  query: string,
): Promise<string> {
  const normalized = query.trim();
  if (normalized.length === 0) throw new Error('search_memory query must not be empty');
  if ([...normalized].length > MAX_MEMORY_QUERY_CHARS) {
    throw new Error(
      `search_memory query must contain at most ${MAX_MEMORY_QUERY_CHARS} Unicode code points`,
    );
  }

  const outcome = await searchTrajectories(projectRoot, normalized, agentId, {
    excludeSessionId: activeSessionId,
    sessionLimit: MAX_MEMORY_SESSIONS,
    limit: MAX_MEMORY_HITS,
  });
  return formatMemorySearch(outcome, activeSessionId);
}

/** Deterministic bounded text returned through the ordinary SDK tool-result event. */
export function formatMemorySearch(outcome: SearchOutcome, activeSessionId: string): string {
  const lines = [`search_memory: ${JSON.stringify(outcome.query)}`];
  lines.push(
    outcome.excludedSessionIds.includes(activeSessionId)
      ? `active session excluded: ${activeSessionId}`
      : `active session excluded by default (not present): ${activeSessionId}`,
  );

  const damaged = outcome.sessions.filter((session) => session.damage !== undefined);
  for (const session of damaged.slice(0, 5)) {
    lines.push(`damage: session=${label(session.sessionId)} — ${session.damage}`);
  }
  if (damaged.length > 5) lines.push(`damage state omitted for ${damaged.length - 5} more session(s)`);

  for (const sessionId of outcome.withoutRecord.slice(0, 5)) {
    lines.push(`missing record: session=${label(sessionId)}`);
  }
  if (outcome.withoutRecord.length > 5) {
    lines.push(`missing-record state omitted for ${outcome.withoutRecord.length - 5} more session(s)`);
  }
  if (outcome.omittedSessions > 0) {
    lines.push(`session limit: ${outcome.omittedSessions} session(s) omitted without scanning`);
  }
  if (outcome.hitCount === 0) lines.push('no matches in the scanned prior-session records');
  if (outcome.limited) lines.push(`hit limit reached: showing ${outcome.hitCount} match(es)`);

  let resultLimited = false;
  const hits = outcome.sessions.flatMap((session) => session.hits);
  for (const hit of hits) {
    const line =
      `source: session=${label(hit.sessionId)} turn=${hit.turn} type=${label(hit.type)} ` +
      `seq=${hit.seq} at=${label(hit.at)} — ${hit.excerpt}`;
    if (points(lines.join('\n')).length + 1 + points(line).length > MAX_MEMORY_RESULT_CHARS - 80) {
      resultLimited = true;
      break;
    }
    lines.push(line);
  }
  if (resultLimited) lines.push('result limit reached: additional matches omitted from this tool result');
  if (outcome.limited || resultLimited || outcome.omittedSessions > 0) {
    lines.push('limits are conservative; refine the literal query to retrieve different matches');
  }

  const rendered = lines.join('\n');
  if (points(rendered).length > MAX_MEMORY_RESULT_CHARS) {
    throw new Error('search_memory result projection exceeded its fixed bound');
  }
  return rendered;
}

function label(value: string): string {
  return value.replace(/\s+/gu, ' ');
}

function points(value: string): string[] {
  return [...value];
}

import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import matter from 'gray-matter';

import { darwinDir, userDarwinDir } from '../paths.js';

export const AGENTS_DIRNAME = 'agents';
export const DEFAULT_AGENT_NAME = 'general';

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  /** Undefined means every child-eligible tool; an empty array means no tools. */
  tools: readonly string[] | undefined;
  /** Absolute Markdown source, or undefined for the built-in definition. */
  file: string | undefined;
}

export interface AgentDefinitionProblem {
  file: string;
  reason: string;
}

export interface AgentDefinitionRegistry {
  definitions: AgentDefinition[];
  problems: AgentDefinitionProblem[];
}

const DEFAULT_AGENT: AgentDefinition = {
  name: DEFAULT_AGENT_NAME,
  description: 'General-purpose agent for independent repository research, coding, and verification tasks.',
  systemPrompt: [
    'You are a general-purpose coding subagent working independently inside a repository.',
    'Complete the delegated task using the available tools when evidence or changes are needed.',
    'Follow all project instructions included below. Do not ask the end user questions: report blockers',
    'to the parent agent instead. Finish with a concise, evidence-based report covering findings,',
    'changes, verification, and any unresolved risks that apply.',
  ].join(' '),
  tools: undefined,
  file: undefined,
};

/**
 * Loads direct Markdown children of `<root>/.darwin/agents/`.
 *
 * Definitions are isolated configuration: one bad file is reported and skipped,
 * while the built-in general agent and every other valid definition remain usable.
 */
export async function loadAgentDefinitions(
  root: string,
  availableToolNames: readonly string[],
): Promise<AgentDefinitionRegistry> {
  const agentDirs = [
    path.join(darwinDir(root), AGENTS_DIRNAME),
    path.join(userDarwinDir(), AGENTS_DIRNAME),
  ];
  const definitions: AgentDefinition[] = [DEFAULT_AGENT];
  const problems: AgentDefinitionProblem[] = [];
  const claimed = new Map<string, string>([[DEFAULT_AGENT_NAME, 'the built-in general agent']]);
  const knownTools = new Set(availableToolNames);

  for (const agentsDir of [...new Set(agentDirs)]) {
    let entries: Dirent[];
    try {
      entries = await readdir(agentsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;

      const file = path.join(agentsDir, entry.name);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      problems.push({ file, reason: `could not read file: ${describe(error)}` });
      continue;
    }

    const parsed = parseDefinition(raw, file, knownTools);
    if ('reason' in parsed) {
      problems.push({ file, reason: parsed.reason });
      continue;
    }

    const normalized = parsed.name.toLowerCase();
    const owner = claimed.get(normalized);
    if (owner !== undefined) {
      problems.push({ file, reason: `agent name ${JSON.stringify(parsed.name)} conflicts with ${owner}` });
      continue;
    }

    claimed.set(normalized, file);
    definitions.push(parsed);
  }

  }

  const custom = definitions.slice(1).sort((a, b) => a.name.localeCompare(b.name));
  return { definitions: [DEFAULT_AGENT, ...custom], problems };
}

function parseDefinition(
  raw: string,
  file: string,
  knownTools: ReadonlySet<string>,
): AgentDefinition | { reason: string } {
  let data: Record<string, unknown>;
  let content: string;
  try {
    ({ data, content } = matter(raw) as unknown as { data: Record<string, unknown>; content: string });
  } catch (error) {
    return { reason: `invalid YAML frontmatter: ${describe(error)}` };
  }

  const name = readString(data['name']);
  if (name === undefined) return { reason: 'frontmatter is missing a non-empty "name" field' };
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    return { reason: `agent name ${JSON.stringify(name)} must match [a-zA-Z0-9_-]{1,64}` };
  }

  const description = readString(data['description']);
  if (description === undefined) {
    return { reason: 'frontmatter is missing a non-empty "description" field' };
  }

  const systemPrompt = content.trim();
  if (systemPrompt === '') return { reason: 'agent system prompt is empty' };

  const parsedTools = parseTools(data['tools'], knownTools);
  if ('reason' in parsedTools) return parsedTools;

  return { name, description, systemPrompt, tools: parsedTools.tools, file };
}

function parseTools(
  value: unknown,
  knownTools: ReadonlySet<string>,
): { tools: readonly string[] | undefined } | { reason: string } {
  if (value === undefined) return { tools: undefined };
  if (!Array.isArray(value)) return { reason: 'frontmatter "tools" must be an array of tool names' };

  const tools: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = readString(item);
    if (name === undefined) return { reason: 'frontmatter "tools" entries must be non-empty strings' };
    if (seen.has(name)) return { reason: `frontmatter "tools" contains duplicate ${JSON.stringify(name)}` };
    if (!knownTools.has(name)) return { reason: `frontmatter "tools" names unknown tool ${JSON.stringify(name)}` };
    seen.add(name);
    tools.push(name);
  }
  return { tools };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The `/context` breakdown: what the next request is made of, component by component
 * (SER-077).
 *
 * The total `/context` prints is one number — measured base plus a counted tail, or
 * one whole-request count — and says nothing about *what* is large. This module
 * counts the parts separately: the system prompt by section as Darwin composes it
 * (base prompt, `<project-instructions>`, the official `<available_skills>`
 * catalogue, `<working-context>`), the tool specs grouped by origin (darwin's own
 * built-ins, then each MCP server by its configured name), and the conversation by
 * role. Every component goes through the same `model.countTokens` the total already
 * uses, so the parts are stated in the total's own units — but they are an
 * *estimate over the current request shape*, never the anchor measurement, and the
 * formatter labels them so. The measured total stays the authoritative line.
 *
 * Two rules from the rest of the runtime hold here. It is computed on demand only:
 * `/context` asks for it, nothing else does — not the post-turn pressure advisory,
 * not `/status` — because a provider-native `countTokens` may reach the provider's
 * counting API and this makes several calls. And a component whose count fails is
 * absent (`tokens: undefined`, rendered `not reported`), never 0: the `usageBuckets`
 * honesty rule. Everything here is a pure function over injected inputs; the
 * runtime supplies the live prompt, tools, servers, messages and the counter.
 */
import type { CountTokensOptions, Message, SystemPrompt, ToolSpec } from '@strands-agents/sdk';

import { composeSystemPrompt } from './instructions.js';
import type { McpServerStatus } from '../mcp/registry.js';
import { knownPromptSections } from '../skills/prompt.js';

/** One counted component of the request. */
export interface ContextComponent {
  /** Bounded label, rendered as written. */
  label: string;
  /** Estimated tokens; absent when the count failed — `not reported`, never 0. */
  tokens: number | undefined;
  /**
   * A stated absence that is not a failed count — e.g. the skills catalogue before
   * the plugin's first injection. Rendered instead of a count when present.
   */
  absent?: string;
}

/** The request, component by component. Row order is the rendering order. */
export interface ContextBreakdown {
  /** System prompt sections in composition order. */
  systemPrompt: ContextComponent[];
  /** Darwin's own tools plus plugin tools — everything no MCP server registered. */
  builtinTools: ContextComponent;
  /** One row per configured MCP server, in configuration order; the formatter bounds them. */
  mcpServers: ContextComponent[];
  /** Conversation messages by role, whole messages only. */
  conversation: ContextComponent[];
}

/** `model.countTokens`, injected so the runtime and an offline suite share one path. */
export type ComponentCounter = (messages: Message[], options: CountTokensOptions) => Promise<number>;

export interface BreakdownInputs {
  /** The live `agent.systemPrompt`. */
  systemPrompt: SystemPrompt | undefined;
  /** The section strings the composition seam produced (`composeSystemPrompt`'s inputs). */
  composed: { base: string; instructions: string | undefined };
  /** The live `agent.tools`. */
  tools: readonly { name: string; toolSpec: ToolSpec }[];
  /** `mcpServerStatuses(...)` — names and registered tool names, never `listTools()`. */
  servers: readonly McpServerStatus[];
  /** The live `agent.messages`. */
  messages: readonly Message[];
}

export const BASE_PROMPT_LABEL = 'system prompt · base';
export const PROJECT_INSTRUCTIONS_LABEL = 'system prompt · project instructions (AGENTS.md)';
/** A restored prompt whose base block no longer equals the current composition. */
export const RESTORED_PROMPT_LABEL = 'system prompt · base + project instructions (restored)';
/** A prompt array in a shape Darwin does not own: counted whole rather than guessed at. */
export const WHOLE_PROMPT_LABEL = 'system prompt';
export const SKILLS_CATALOGUE_LABEL = 'system prompt · skills catalogue';
export const WORKING_CONTEXT_LABEL = 'system prompt · working context';
export const CATALOGUE_NOT_INJECTED = 'not yet injected (added before the first model call)';
export const BUILTIN_TOOLS_LABEL = 'tools · darwin built-ins';
export const UNATTRIBUTED_TOOLS_LABEL = 'tools · darwin built-ins and unattributed';
export const MCP_TOOLS_LABEL_PREFIX = 'tools · mcp ';
export const USER_MESSAGES_LABEL = 'conversation · user prompts and tool results';
export const ASSISTANT_MESSAGES_LABEL = 'conversation · assistant replies and tool calls';

/**
 * Counts every component with `countTokens`, one call per component, sequentially
 * so a provider-backed counter is never fanned out. A failed count is recorded as
 * absent and the rest are still counted: one gap costs one row, never the report.
 */
export async function measureContextBreakdown(
  inputs: BreakdownInputs,
  countTokens: ComponentCounter,
): Promise<ContextBreakdown> {
  const count = async (label: string, messages: Message[], options: CountTokensOptions): Promise<ContextComponent> => {
    try {
      return { label, tokens: await countTokens(messages, options) };
    } catch {
      return { label, tokens: undefined };
    }
  };

  const systemPrompt: ContextComponent[] = [];
  const sections = knownPromptSections(inputs.systemPrompt);
  if (sections === undefined) {
    if (inputs.systemPrompt !== undefined) {
      systemPrompt.push(await count(WHOLE_PROMPT_LABEL, [], { systemPrompt: inputs.systemPrompt }));
    }
  } else {
    const composed = composeSystemPrompt(inputs.composed.base, inputs.composed.instructions === undefined
      ? undefined
      : { fragment: inputs.composed.instructions });
    if (sections.base === composed.trimEnd()) {
      // The live block is exactly what this run composed, so the seam strings are
      // its sections and can be counted apart.
      systemPrompt.push(await count(BASE_PROMPT_LABEL, [], { systemPrompt: inputs.composed.base }));
      if (inputs.composed.instructions !== undefined) {
        systemPrompt.push(await count(PROJECT_INSTRUCTIONS_LABEL, [], { systemPrompt: inputs.composed.instructions }));
      }
    } else {
      // A resumed session carries the snapshot's prompt, which may predate an
      // AGENTS.md edit: the split is unknowable, so the block is counted whole.
      systemPrompt.push(await count(RESTORED_PROMPT_LABEL, [], { systemPrompt: sections.base }));
    }
    systemPrompt.push(
      sections.catalogue === undefined
        ? { label: SKILLS_CATALOGUE_LABEL, tokens: undefined, absent: CATALOGUE_NOT_INJECTED }
        : await count(SKILLS_CATALOGUE_LABEL, [], { systemPrompt: sections.catalogue }),
    );
    if (sections.workingContext !== undefined) {
      systemPrompt.push(await count(WORKING_CONTEXT_LABEL, [], { systemPrompt: sections.workingContext }));
    }
  }

  const groups = groupToolsByOrigin(inputs.tools, inputs.servers);
  const builtinTools = await count(groups.builtinLabel, [], { toolSpecs: groups.builtins });
  const mcpServers: ContextComponent[] = [];
  for (const server of groups.servers) {
    mcpServers.push(
      server.specs === undefined
        ? { label: server.label, tokens: undefined }
        : await count(server.label, [], { toolSpecs: server.specs }),
    );
  }

  const byRole = (role: Message['role']) => inputs.messages.filter((message) => message.role === role);
  const conversation = [
    await count(USER_MESSAGES_LABEL, byRole('user'), {}),
    await count(ASSISTANT_MESSAGES_LABEL, byRole('assistant'), {}),
  ];

  return { systemPrompt, builtinTools, mcpServers, conversation };
}

export interface ToolOriginGroups {
  /** Names the built-in row honestly when a server's tool names could not be read. */
  builtinLabel: string;
  builtins: ToolSpec[];
  /** `specs` is absent when the server's registered names are unavailable. */
  servers: { label: string; specs: ToolSpec[] | undefined }[];
}

/**
 * Attributes each live tool spec to the MCP server that registered it, by the
 * names `mcpServerStatuses` already reads; whatever no server claims is darwin's
 * own (built-ins, plugin tools, parent-only tools). A server whose names cannot be
 * read gets a row with no specs — its tools then land in the built-in group, which
 * says so in its label rather than passing them off as darwin's.
 */
export function groupToolsByOrigin(
  tools: readonly { name: string; toolSpec: ToolSpec }[],
  servers: readonly McpServerStatus[],
): ToolOriginGroups {
  const owner = new Map<string, string>();
  let unattributed = false;
  for (const server of servers) {
    if (server.toolNames === undefined) {
      unattributed = true;
      continue;
    }
    for (const name of server.toolNames) owner.set(name, server.name);
  }
  const perServer = new Map<string, ToolSpec[]>();
  const builtins: ToolSpec[] = [];
  for (const tool of tools) {
    const server = owner.get(tool.name);
    if (server === undefined) {
      builtins.push(tool.toolSpec);
      continue;
    }
    const specs = perServer.get(server) ?? [];
    specs.push(tool.toolSpec);
    perServer.set(server, specs);
  }
  return {
    builtinLabel: unattributed ? UNATTRIBUTED_TOOLS_LABEL : BUILTIN_TOOLS_LABEL,
    builtins,
    servers: servers.map((server) => ({
      label: `${MCP_TOOLS_LABEL_PREFIX}${server.name}`,
      specs: server.toolNames === undefined ? undefined : perServer.get(server.name) ?? [],
    })),
  };
}

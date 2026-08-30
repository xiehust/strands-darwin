/**
 * The one child-agent construction recipe shared by every delegation surface.
 *
 * `SubagentTool` (one child per dispatch) and `WorkflowTool` (one child per DAG
 * node) must build indistinguishable children: same system prompt composition,
 * same per-definition tool filtering, same shared permission intervention, same
 * dispatch-registry provenance and phase hooks, same max-tokens recovery, same
 * bash-session reaping. Extracting the recipe here is what keeps them from
 * drifting — neither caller may construct a child `Agent` directly.
 */
import { randomUUID } from 'node:crypto';

import {
  AfterModelCallEvent,
  AfterToolCallEvent,
  Agent,
  BeforeModelCallEvent,
  BeforeToolCallEvent,
  SummarizingConversationManager,
} from '@strands-agents/sdk';
import type { InterventionHandler, Model, Tool } from '@strands-agents/sdk';

import type { ProjectInstructions } from '../agent/instructions.js';
import { composeSystemPrompt } from '../agent/instructions.js';
import { installMaxTokensRecovery } from '../agent/max-tokens-recovery.js';
import type { AppConfig } from '../config.js';
import type { SubagentDispatchHandle } from './dispatch-registry.js';
import type { AgentDefinition } from './loader.js';

export interface ChildRecipeOptions {
  definition: AgentDefinition;
  /** Config snapshot the caller took before its async model construction. */
  config: AppConfig;
  model: Model;
  /** The parent's child-eligible catalogue; filtered per definition here. */
  tools: readonly Tool[];
  /** The parent's own gate instance, so live allow-rules keep applying. */
  intervention: InterventionHandler;
  projectInstructions: ProjectInstructions | undefined;
  /** Part of the child agent id: `darwin-<idPrefix>-<name>-<uuid>`. */
  idPrefix: string;
  dispatch: SubagentDispatchHandle | undefined;
}

/**
 * Builds one fresh, isolated child Agent and binds it to its dispatch record.
 *
 * The child never receives a `SessionManager`, parent messages, or a delegation
 * tool; its conversation manager mirrors the main Agent's overflow strategy from
 * the same config snapshot. Hooks expose only operation boundaries — never model
 * messages, tool input/results, reasoning, or child transcript.
 */
export function buildRecipeChild(options: ChildRecipeOptions): Agent {
  const { definition, config, dispatch } = options;
  const child = new Agent({
    id: `darwin-${options.idPrefix}-${definition.name}-${randomUUID()}`,
    name: definition.name,
    description: definition.description,
    model: options.model,
    systemPrompt: composeSystemPrompt(definition.systemPrompt, options.projectInstructions),
    tools: toolsForDefinition(definition, options.tools),
    conversationManager: new SummarizingConversationManager({
      summaryRatio: config.summaryRatio,
      preserveRecentMessages: config.preserveRecentMessages,
    }),
    interventions: [options.intervention],
    printer: false,
  });
  installMaxTokensRecovery(child);
  child.addHook(BeforeModelCallEvent, () => dispatch?.setPhase({ kind: 'model' }));
  child.addHook(AfterModelCallEvent, () => dispatch?.setPhase({ kind: 'starting' }));
  child.addHook(BeforeToolCallEvent, (event) => {
    dispatch?.setPhase({ kind: 'tool', toolName: event.toolUse.name });
  });
  child.addHook(AfterToolCallEvent, () => dispatch?.setPhase({ kind: 'starting' }));
  // Before initialize(), so the first gated call resolves to its dispatch and a
  // targeted cancellation can stop only this child.
  dispatch?.attachAgent(child.id);
  dispatch?.attachCancel(() => child.cancel());
  return child;
}

/** `tools` omitted means the whole eligible catalogue, `[]` none, a list an exact filter. */
export function toolsForDefinition(definition: AgentDefinition, tools: readonly Tool[]): Tool[] {
  if (definition.tools === undefined) return [...tools];
  const allowed = new Set(definition.tools);
  return tools.filter((candidate) => allowed.has(candidate.name));
}

/** Reaps the persistent shell associated with one child Agent, if it used bash. */
export async function stopBashSession(agent: Agent): Promise<void> {
  if (!agent.tools.some((candidate) => candidate.name === 'bash')) return;

  try {
    await agent.tool['bash']?.invoke({ mode: 'restart' }, { recordDirectToolCall: false });
  } catch {
    // Cleanup is best-effort; the child's original result or failure takes priority.
  }
}

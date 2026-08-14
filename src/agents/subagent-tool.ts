import { randomUUID } from 'node:crypto';

import { Agent, tool } from '@strands-agents/sdk';
import type { InterventionHandler, Model, Tool, ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';

import type { ProjectInstructions } from '../agent/instructions.js';
import { composeSystemPrompt } from '../agent/instructions.js';
import type { AppConfig } from '../config.js';
import type { AgentDefinition, AgentDefinitionRegistry } from './loader.js';
import { DEFAULT_AGENT_NAME } from './loader.js';

export const SUBAGENT_TOOL_NAME = 'subagent';

export interface SubagentToolOptions {
  registry: AgentDefinitionRegistry;
  tools: readonly Tool[];
  intervention: InterventionHandler;
  projectInstructions: ProjectInstructions | undefined;
  config: AppConfig;
  createModel: (config: AppConfig) => Promise<Model>;
}

/**
 * Owns the main agent's delegation tool and every transient child it creates.
 *
 * This deliberately does not use SDK `Agent.asTool()`: that adapter forwards the
 * child's stream events through the parent tool stream. Consuming `invoke()` here
 * keeps the child's reasoning, messages, and tool transcript private and returns
 * only its final report to the main conversation.
 */
export class SubagentTool {
  readonly tool: Tool;
  private config: AppConfig;
  private readonly activeAgents = new Set<Agent>();
  private readonly activeExecutions = new Set<Promise<string>>();

  constructor(private readonly options: SubagentToolOptions) {
    this.config = options.config;
    const catalogue = options.registry.definitions
      .map((definition) => `${definition.name}: ${definition.description}`)
      .join('; ');

    this.tool = tool({
      name: SUBAGENT_TOOL_NAME,
      description:
        'Delegate a self-contained task to a fresh child agent with an independent context. ' +
        `Only the final report is returned. Available agents: ${catalogue}`,
      inputSchema: z.object({
        task: z.string().min(1).describe('A complete, self-contained task for the child agent'),
        agent: z.string().optional().describe(`Agent name; defaults to ${DEFAULT_AGENT_NAME}`),
      }),
      callback: ({ task, agent }, context) => this.track(task, agent, context),
    });
  }

  /** Future dispatches use this config; active children keep their existing model. */
  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  /** Cooperatively stops every child currently running. */
  cancelActive(): void {
    for (const agent of this.activeAgents) agent.cancel();
  }

  /** Cancels active children and waits for their per-dispatch cleanup to finish. */
  async shutdown(): Promise<void> {
    this.cancelActive();
    await Promise.allSettled([...this.activeExecutions]);
  }

  private track(task: string, requestedName: string | undefined, context?: ToolContext): Promise<string> {
    const execution = this.dispatch(task, requestedName, context);
    this.activeExecutions.add(execution);
    void execution.then(
      () => this.activeExecutions.delete(execution),
      () => this.activeExecutions.delete(execution),
    );
    return execution;
  }

  private async dispatch(
    task: string,
    requestedName: string | undefined,
    context?: ToolContext,
  ): Promise<string> {
    const definition = this.find(requestedName ?? DEFAULT_AGENT_NAME);
    if (definition === undefined) {
      const available = this.options.registry.definitions.map((candidate) => candidate.name).join(', ');
      return `No subagent named ${JSON.stringify(requestedName)}. Available agents: ${available}.`;
    }

    // Snapshot the live config before the async model construction. A concurrent
    // /model switch affects the next dispatch, never a child already being built.
    const config = this.config;
    const model = await this.options.createModel(config);
    // Cancellation can land while a provider module/model is being constructed,
    // before there is a child Agent to cancel. Do not start one after its parent
    // invocation has already been abandoned.
    if (context?.agent.cancelSignal.aborted === true) return 'Subagent task cancelled.';

    const child = new Agent({
      id: `darwin-subagent-${definition.name}-${randomUUID()}`,
      name: definition.name,
      description: definition.description,
      model,
      systemPrompt: composeSystemPrompt(definition.systemPrompt, this.options.projectInstructions),
      tools: this.toolsFor(definition),
      interventions: [this.options.intervention],
      printer: false,
    });

    this.activeAgents.add(child);
    const cancelChild = () => child.cancel();
    context?.agent.cancelSignal.addEventListener('abort', cancelChild, { once: true });

    try {
      await child.initialize();
      const result = await child.invoke(task);
      return result.toString();
    } finally {
      context?.agent.cancelSignal.removeEventListener('abort', cancelChild);
      this.activeAgents.delete(child);
      await stopBashSession(child);
    }
  }

  private find(name: string): AgentDefinition | undefined {
    const normalized = name.trim().toLowerCase();
    return this.options.registry.definitions.find(
      (definition) => definition.name.toLowerCase() === normalized,
    );
  }

  private toolsFor(definition: AgentDefinition): Tool[] {
    if (definition.tools === undefined) return [...this.options.tools];
    const allowed = new Set(definition.tools);
    return this.options.tools.filter((candidate) => allowed.has(candidate.name));
  }
}

/** Reaps the persistent shell associated with one child Agent, if it used bash. */
async function stopBashSession(agent: Agent): Promise<void> {
  if (!agent.tools.some((candidate) => candidate.name === 'bash')) return;

  try {
    await agent.tool['bash']?.invoke({ mode: 'restart' }, { recordDirectToolCall: false });
  } catch {
    // Cleanup is best-effort; the child's original result or failure takes priority.
  }
}

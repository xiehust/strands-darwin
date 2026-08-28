import { randomUUID } from 'node:crypto';

import {
  AfterModelCallEvent,
  AfterToolCallEvent,
  Agent,
  BeforeModelCallEvent,
  BeforeToolCallEvent,
  SummarizingConversationManager,
  tool,
} from '@strands-agents/sdk';
import type { InterventionHandler, Model, Tool, ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';

import type { ProjectInstructions } from '../agent/instructions.js';
import { composeSystemPrompt } from '../agent/instructions.js';
import { installMaxTokensRecovery, withRetainedMaxTokensText } from '../agent/max-tokens-recovery.js';
import type { AppConfig } from '../config.js';
import { injectCodexContext, type CodexHookRunner } from '../hooks/codex-hook-runner.js';
import type { SubagentDispatchHandle, SubagentDispatchRegistry } from './dispatch-registry.js';
import type { AgentDefinition, AgentDefinitionRegistry } from './loader.js';
import { DEFAULT_AGENT_NAME } from './loader.js';

export const SUBAGENT_TOOL_NAME = 'subagent';

type ChildAgentObserver = (agent: Agent) => void;

export interface SubagentToolOptions {
  registry: AgentDefinitionRegistry;
  tools: readonly Tool[];
  intervention: InterventionHandler;
  projectInstructions: ProjectInstructions | undefined;
  config: AppConfig;
  createModel: (config: AppConfig) => Promise<Model>;
  /**
   * Records per-dispatch state and gives the permission gate its provenance.
   * Omitted only by narrow tests that exercise isolation alone: without it a
   * dispatch is unobservable and its child's approvals cannot be labelled.
   */
  dispatches?: SubagentDispatchRegistry;
  /** Shared portable hook policy; child context remains invocation-local. */
  codexHooks?: CodexHookRunner;
  /** Test/diagnostic observer; receives the real child after initialization. */
  onChildInitialized?: ChildAgentObserver;
}

/**
 * Owns the main agent's delegation tool and every transient child it creates.
 *
 * This deliberately does not use SDK `Agent.asTool()`: that adapter forwards the
 * child's stream events through the parent tool stream. Consuming `invoke()` here
 * keeps the child's reasoning, messages, and tool transcript private and returns
 * only its final report to the main conversation.
 *
 * Dispatch is re-entrant, and the SDK's default `ConcurrentToolExecutor` races the
 * per-tool generators, so two `subagent` blocks in one assistant message really do
 * run at the same time (measured in `spike/verify-subagents.ts`). That parallelism
 * is scoped to **read-heavy** delegation on purpose: concurrent children share one
 * working tree with no isolation or conflict detection, so nothing here makes
 * concurrent write delegation safe. Keep mutation on one agent at a time.
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

    // Recorded only once the request names a real agent: an unknown name never
    // dispatched anything, so it must not show up as a run that failed.
    const dispatch = this.options.dispatches?.begin({
      agentName: definition.name,
      task,
      toolUseId: context?.toolUse.toolUseId,
    });

    try {
      return await this.run(definition, task, dispatch, context);
    } catch (error) {
      dispatch?.finish('failed');
      throw error;
    }
  }

  private async run(
    definition: AgentDefinition,
    task: string,
    dispatch: SubagentDispatchHandle | undefined,
    context?: ToolContext,
  ): Promise<string> {
    // Snapshot the live config before the async model construction. A concurrent
    // /model switch affects the next dispatch, never a child already being built.
    const config = this.config;
    const model = await this.options.createModel(config);
    // Cancellation can land while a provider module/model is being constructed,
    // before there is a child Agent to cancel. Targeted cancellation uses the same
    // latch, without cancelling the parent or a sibling dispatch.
    if (context?.agent.cancelSignal.aborted === true || dispatch?.cancellationRequested() === true) {
      dispatch?.finish('cancelled');
      return 'Subagent task cancelled.';
    }

    // A child owns its portable lifecycle commands so targeted cancellation and
    // settlement cannot cancel or wait on a sibling or parent hook process.
    const childCodexHooks = this.options.codexHooks?.fork();
    const child = new Agent({
      id: `darwin-subagent-${definition.name}-${randomUUID()}`,
      name: definition.name,
      description: definition.description,
      model,
      systemPrompt: composeSystemPrompt(definition.systemPrompt, this.options.projectInstructions),
      tools: this.toolsFor(definition),
      conversationManager: new SummarizingConversationManager({
        summaryRatio: config.summaryRatio,
        preserveRecentMessages: config.preserveRecentMessages,
      }),
      interventions: [this.options.intervention],
      printer: false,
    });
    installMaxTokensRecovery(child);
    // Hooks expose only operation boundaries. Never inspect model messages, tool
    // input/results, reasoning, or child transcript for progress.
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

    this.activeAgents.add(child);
    const cancelChild = () => child.cancel();
    context?.agent.cancelSignal.addEventListener('abort', cancelChild, { once: true });

    try {
      await child.initialize();
      this.options.onChildInitialized?.(child);
      const invocationState = {};
      const hookContext = await childCodexHooks?.subagentStart({
        id: child.id,
        name: definition.name,
      });
      const result = await child.invoke(injectCodexContext(task, hookContext), { invocationState });
      const outcome = result.stopReason === 'cancelled' ? 'cancelled' : 'succeeded';
      dispatch?.finish(outcome);
      const report = withRetainedMaxTokensText(result.toString(), invocationState);
      // Child assistant text is private until the ordinary bounded tool result is
      // returned. Do not duplicate it into a lifecycle command payload.
      void childCodexHooks?.subagentStop({
        id: child.id,
        name: definition.name,
        outcome,
      });
      return report;
    } finally {
      context?.agent.cancelSignal.removeEventListener('abort', cancelChild);
      this.activeAgents.delete(child);
      childCodexHooks?.cancel();
      await Promise.allSettled([
        stopBashSession(child),
        childCodexHooks?.close() ?? Promise.resolve(),
      ]);
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

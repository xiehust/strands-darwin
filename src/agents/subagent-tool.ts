import { Agent, tool } from '@strands-agents/sdk';
import type { AgentResult, InterventionHandler, InvocationState, Model, Tool, ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';

import type { ProjectInstructions } from '../agent/instructions.js';
import { backgroundDelegationDescriptionClause } from '../agent/background-delegation.js';
import { withRetainedMaxTokensText } from '../agent/max-tokens-recovery.js';
import { childRefusalError, isRefusalStop } from '../agent/refusal.js';
import { isRetryableStreamInterruption, STREAM_CONTINUATION_PROMPT } from '../agent/stream-resumption.js';
import type { AppConfig } from '../config.js';
import { injectCodexContext, type CodexHookRunner } from '../hooks/codex-hook-runner.js';
import { buildRecipeChild, stopBashSession } from './child-recipe.js';
import { concurrencyCap, concurrencyDescriptionClause, concurrencyLimitMessage } from './concurrency-limit.js';
import type { SubagentDispatchHandle, SubagentDispatchRegistry } from './dispatch-registry.js';
import { withFailedChildText } from './failed-child-text.js';
import type { AgentDefinition, AgentDefinitionRegistry } from './loader.js';
import { DEFAULT_AGENT_NAME } from './loader.js';
import { projectChildReport } from './report-projection.js';
import { MAX_RETAINED_CHILDREN, RetainedChildStore, type RetainedChild } from './retained-children.js';

export const SUBAGENT_TOOL_NAME = 'subagent';

/** The one sentence the tool description spends on `continue` (SER-075). */
export const CONTINUE_DESCRIPTION_CLAUSE =
  `Pass continue: "<dispatch id>" (the 8-character id on the /agents row and in the live subagent row — the first 8 ` +
  `alphanumeric characters of that call's tool_use id after any tooluse_ prefix) to send the task as a follow-up ` +
  `into a finished child's retained conversation instead of briefing a fresh one; the last ` +
  `${MAX_RETAINED_CHILDREN} settled children of this session are kept.`;

/** The one clause the tool description spends on the child's stream continuation (SRF-026). */
export const STREAM_CONTINUATION_DESCRIPTION_CLAUSE =
  'A child whose model stream is interrupted mid-answer is continued once from its own conversation; ' +
  'a second failure is reported as the original error.';

/** The fixed line joining the interruption and the failed continuation in the rethrown message. */
export const CONTINUATION_FAILED_NOTE = 'one continuation on the same child also failed:';

/**
 * The error `SubagentTool` rethrows when the one continuation after a stream
 * interruption fails too (SRF-026). The interruption stays the error: its `name`
 * and, as `cause`, the object itself are preserved, so the retry guard's failure
 * class and `turnEnded.failure` keep their shape; the message names both
 * failures so nothing about the second is lost.
 */
export function continuationFailure(interruption: Error, second: unknown): Error {
  const secondMessage = second instanceof Error ? second.message : String(second);
  const wrapped = new Error(`${interruption.message}\n${CONTINUATION_FAILED_NOTE} ${secondMessage}`, { cause: interruption });
  wrapped.name = interruption.name;
  return wrapped;
}

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
  /**
   * The parent runtime wakes on a background child's settlement (SER-070), so the
   * description says the report arrives in the next turn; unset keeps the same-turn
   * sentence a non-waking runtime can honour.
   */
  backgroundCompletionWakes?: boolean;
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
  /**
   * Settled children's conversations for `continue` (SER-075). Per tool, so per
   * runtime: `/clear` and `/rewind` build a successor tool and `shutdown()` clears
   * this one. Conversations only — never the Agent or its bash session.
   */
  private readonly retained = new RetainedChildStore();

  constructor(private readonly options: SubagentToolOptions) {
    this.config = options.config;
    const catalogue = options.registry.definitions
      .map((definition) => `${definition.name}: ${definition.description}`)
      .join('; ');

    this.tool = tool({
      name: SUBAGENT_TOOL_NAME,
      description:
        'Delegate a self-contained task to a fresh child agent with an independent context. ' +
        `Only the final report is returned. ${concurrencyDescriptionClause(concurrencyCap(options.config))} ` +
        `${backgroundDelegationDescriptionClause(options.backgroundCompletionWakes === true)} ` +
        `${CONTINUE_DESCRIPTION_CLAUSE} ` +
        `${STREAM_CONTINUATION_DESCRIPTION_CLAUSE} ` +
        `Available agents: ${catalogue}`,
      inputSchema: z.object({
        task: z.string().min(1).describe('A complete, self-contained task for the child agent'),
        agent: z.string().optional().describe(`Agent name; defaults to ${DEFAULT_AGENT_NAME}`),
        continue: z.string().optional().describe(
          "Dispatch id of a finished child to continue; the follow-up `task` is sent into that child's retained conversation",
        ),
      }),
      callback: ({ task, agent, continue: continued }, context) => this.track(task, agent, continued, context),
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

  /** Cancels active children, waits for their per-dispatch cleanup, and drops every retained conversation. */
  async shutdown(): Promise<void> {
    this.cancelActive();
    await Promise.allSettled([...this.activeExecutions]);
    this.retained.clear();
  }

  /** Ids of the settled children currently continuable, oldest first — ids only, never their conversations. */
  retainedDispatchIds(): string[] {
    return this.retained.ids();
  }

  private track(
    task: string,
    requestedName: string | undefined,
    continued: string | undefined,
    context?: ToolContext,
  ): Promise<string> {
    const execution = this.dispatch(task, requestedName, continued, context);
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
    continued: string | undefined,
    context?: ToolContext,
  ): Promise<string> {
    // A continuation resolves its definition from the retained entry, and every
    // refusal below happens before any model, dispatch record or child exists.
    const continuation = continued === undefined ? undefined : this.resolveContinuation(continued, requestedName);
    const definition = this.find(continuation?.agentName ?? requestedName ?? DEFAULT_AGENT_NAME);
    if (definition === undefined) {
      const available = this.options.registry.definitions.map((candidate) => candidate.name).join(', ');
      return `No subagent named ${JSON.stringify(requestedName)}. Available agents: ${available}.`;
    }

    // The ceiling is checked before anything is constructed: a refused call
    // builds no model, begins no dispatch and creates no child. Settlement on the
    // registry's terminal transition is the only thing that frees a slot, so the
    // error tells the model to wait for a result rather than retry. Live config
    // on purpose (not a constructor snapshot): `/model` hands the tool a new one.
    if (this.options.dispatches !== undefined) {
      const cap = concurrencyCap(this.config);
      const running = this.options.dispatches.runningCount();
      if (running >= cap) throw new Error(concurrencyLimitMessage(cap, running));
    }

    // Recorded only once the request names a real agent: an unknown name never
    // dispatched anything, so it must not show up as a run that failed.
    const dispatch = this.options.dispatches?.begin({
      agentName: definition.name,
      task,
      toolUseId: context?.toolUse.toolUseId,
      ...(continuation === undefined ? {} : { continuedFrom: continuation.dispatchId }),
    });

    try {
      return await this.run(definition, task, dispatch, context, continuation);
    } catch (error) {
      dispatch?.finish('failed');
      throw error;
    }
  }

  /**
   * The retained entry for `continue=<id>`, or one bounded error naming why there
   * is none: still running, cancelled, evicted, skipped (broken pair), settled
   * outside this tool (a `workflow` node), unknown, or a different `agent`.
   */
  private resolveContinuation(continued: string, requestedName: string | undefined): RetainedChild {
    const dispatchId = continued.trim();
    const lookup = this.retained.lookup(dispatchId);
    if (lookup.kind === 'retained') {
      const { entry } = lookup;
      if (requestedName !== undefined && requestedName.trim().toLowerCase() !== entry.agentName.toLowerCase()) {
        throw new Error(
          `Subagent dispatch ${dispatchId} ran agent ${entry.agentName}; continue it without agent or with agent=${entry.agentName}.`,
        );
      }
      return entry;
    }
    const recorded = this.options.dispatches?.list().filter((status) => status.dispatchId === dispatchId) ?? [];
    if (recorded.some((status) => status.state === 'running')) {
      throw new Error(`Subagent dispatch ${dispatchId} is still running; wait for its result before continuing it.`);
    }
    if (lookup.kind === 'evicted') {
      throw new Error(
        `Subagent dispatch ${dispatchId} was evicted from the retained children ` +
        `(only the last ${MAX_RETAINED_CHILDREN} settled dispatches are kept); brief a fresh child instead.`,
      );
    }
    if (lookup.kind === 'skipped') {
      throw new Error(`Subagent dispatch ${dispatchId} was not retained for continuation: ${lookup.reason}.`);
    }
    if (recorded.some((status) => status.state === 'cancelled')) {
      throw new Error(`Subagent dispatch ${dispatchId} was not retained for continuation: cancelled children are not retained.`);
    }
    if (recorded.length > 0) {
      throw new Error(
        `Subagent dispatch ${dispatchId} was not retained for continuation: ` +
        'only settled subagent dispatches are; workflow nodes never are.',
      );
    }
    throw new Error(`No subagent dispatch ${dispatchId} to continue in this session.`);
  }

  private async run(
    definition: AgentDefinition,
    task: string,
    dispatch: SubagentDispatchHandle | undefined,
    context?: ToolContext,
    continuation?: RetainedChild,
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
    const child = buildRecipeChild({
      definition,
      config,
      model,
      tools: this.options.tools,
      intervention: this.options.intervention,
      projectInstructions: this.options.projectInstructions,
      idPrefix: 'subagent',
      dispatch,
      // Fresh clones per continuation: the store's copy stays pristine, so the
      // same settled child can be continued again after this one settles.
      ...(continuation === undefined ? {} : { messages: continuation.messages.map((message) => message.clone()) }),
    });

    this.activeAgents.add(child);
    const cancelChild = () => child.cancel();
    context?.agent.cancelSignal.addEventListener('abort', cancelChild, { once: true });
    const invocationState = {};

    try {
      await child.initialize();
      this.options.onChildInitialized?.(child);
      const hookContext = await childCodexHooks?.subagentStart({
        id: child.id,
        name: definition.name,
      });
      const result = await this.invokeWithStreamContinuation(
        child,
        injectCodexContext(task, hookContext),
        invocationState,
        dispatch,
        context,
      );
      // A refused child is a failed delegation, not a report: the SDK ends the turn
      // normally, so the outcome has to be named here — with the stop reason actually
      // received — before it reads as success.
      if (isRefusalStop(result.stopReason)) throw new Error(childRefusalError(result.stopReason));
      const outcome = result.stopReason === 'cancelled' ? 'cancelled' : 'succeeded';
      dispatch?.finish(outcome);
      this.retainSettled(dispatch, definition, child, outcome, continuation);
      // The one seam where child text becomes the parent's tool result: escape
      // imitation of darwin's own framing and mark it, never remove or reword.
      const report = projectChildReport(withRetainedMaxTokensText(result.toString(), invocationState));
      // Child assistant text is private until the ordinary bounded tool result is
      // returned. Do not duplicate it into a lifecycle command payload.
      void childCodexHooks?.subagentStop({
        id: child.id,
        name: definition.name,
        outcome,
      });
      return report;
    } catch (error) {
      // The caller settles the dispatch `failed`; a cancelled child is not a failure
      // and is never retained, a failed one only with a whole conversation.
      this.retainSettled(dispatch, definition, child, child.cancelSignal.aborted ? 'cancelled' : 'failed', continuation);
      // Still an error (dispatch settles `failed` in the caller): only the message
      // grows, by the child's bounded last assistant text through the same projection.
      throw withFailedChildText(error, child, invocationState);
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

  /**
   * The child's counterpart of the driver's `runWithStreamResumption` (SRF-026):
   * one ordinary `invoke` on the same live child after the exact stream-interruption
   * `ModelError`, at this call site only — never inside the SDK loop, the model, the
   * recipe or the runtime. The child's in-memory conversation ends at its last tool
   * result, so the bounded anti-repeat prompt is an ordinary user-role message and
   * the original task is not resent. A cancelled child (its own signal, the parent's
   * or a targeted `/agents cancel`) and every other error class are rethrown as
   * they are; a second failure of any class is the interruption with the second
   * message appended (`continuationFailure`). At most one continuation per dispatch:
   * a `continue=<id>` follow-up is its own dispatch with its own single attempt.
   * `workflow` nodes never pass through here.
   */
  private async invokeWithStreamContinuation(
    child: Agent,
    input: string,
    invocationState: InvocationState,
    dispatch: SubagentDispatchHandle | undefined,
    context: ToolContext | undefined,
  ): Promise<AgentResult> {
    try {
      return await child.invoke(input, { invocationState });
    } catch (error) {
      if (!isRetryableStreamInterruption(error)) throw error;
      if (
        child.cancelSignal.aborted
        || context?.agent.cancelSignal.aborted === true
        || dispatch?.cancellationRequested() === true
      ) throw error;
      dispatch?.setPhase({ kind: 'continuing-after-stream-interruption' });
      try {
        return await child.invoke(STREAM_CONTINUATION_PROMPT, { invocationState });
      } catch (second) {
        // A continuation cancelled mid-turn is still a cancellation, never wrapped.
        if (child.cancelSignal.aborted) throw second;
        throw continuationFailure(error, second);
      }
    }
  }

  /**
   * Hands one settled child's conversation to the store (SER-075). Reads the SDK
   * `Agent.messages` accessor once, at settlement; the Agent itself is dropped by
   * the caller's `finally` as before. Without a dispatch record there is no id to
   * continue by, so narrow registry-less fixtures retain nothing.
   */
  private retainSettled(
    dispatch: SubagentDispatchHandle | undefined,
    definition: AgentDefinition,
    child: Agent,
    state: 'succeeded' | 'failed' | 'cancelled',
    continuation: RetainedChild | undefined,
  ): void {
    if (dispatch === undefined) return;
    this.retained.retain({
      dispatchId: dispatch.dispatchId,
      agentName: definition.name,
      state,
      messages: child.messages,
      ...(continuation === undefined ? {} : { continuedFrom: continuation.dispatchId }),
    });
  }

  private find(name: string): AgentDefinition | undefined {
    const normalized = name.trim().toLowerCase();
    return this.options.registry.definitions.find(
      (definition) => definition.name.toLowerCase() === normalized,
    );
  }
}

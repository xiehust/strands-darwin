/**
 * SER-045: the parent-only `workflow` tool — a bounded declarative DAG of
 * subagent tasks executed by the SDK `Graph` orchestrator.
 *
 * Input is data, never code: node ids, agent names, task strings and plain
 * `[source, target]` edge pairs. Everything that schedules — AND-semantics
 * dependency resolution, dependency-merged node inputs, `maxConcurrency` — is
 * the installed SDK `Graph`; this module never reimplements any of it. An
 * invalid DAG is a bounded tool error before any child is constructed.
 *
 * Each node is a fresh child built by the exact recipe `SubagentTool` uses
 * (`buildRecipeChild`): config/model snapshot, composed system prompt,
 * per-definition tool filtering, the shared permission intervention with
 * dispatch `source` provenance, registry heartbeats + targeted `/agents cancel`,
 * codex-hook fork, max-tokens recovery, bash-session reaping. Only the graph's
 * bounded terminus content returns to the parent; child transcripts stay
 * private and no child event reaches the trajectory.
 */
import { randomUUID } from 'node:crypto';

import { Agent, AgentResult, Graph, Message, TextBlock, tool } from '@strands-agents/sdk';
import type {
  ContentBlock,
  InterventionHandler,
  InvocationState,
  InvokeArgs,
  InvokeOptions,
  Model,
  StreamEvent,
  Tool,
  ToolContext,
} from '@strands-agents/sdk';
import { z } from 'zod';

import type { ProjectInstructions } from '../agent/instructions.js';
import { withRetainedMaxTokensText } from '../agent/max-tokens-recovery.js';
import type { AppConfig } from '../config.js';
import { injectCodexContext, type CodexHookRunner } from '../hooks/codex-hook-runner.js';
import { buildRecipeChild, stopBashSession } from './child-recipe.js';
import type { SubagentDispatchHandle, SubagentDispatchRegistry } from './dispatch-registry.js';
import type { AgentDefinition, AgentDefinitionRegistry } from './loader.js';
import { DEFAULT_AGENT_NAME } from './loader.js';

export const WORKFLOW_TOOL_NAME = 'workflow';
export const MAX_WORKFLOW_NODES = 8;
/** The largest simple DAG on {@link MAX_WORKFLOW_NODES} nodes: n·(n−1)/2. */
export const MAX_WORKFLOW_EDGES = 28;

const workflowInputSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(64).describe('Unique node id; edges reference it'),
        agent: z.string().optional().describe(`Agent name; defaults to ${DEFAULT_AGENT_NAME}`),
        task: z.string().min(1).describe('A complete, self-contained task for this node'),
      }),
    )
    .min(1)
    .max(MAX_WORKFLOW_NODES, `workflow allows at most ${MAX_WORKFLOW_NODES} nodes`)
    .describe('The workflow steps; each runs as one fresh child agent'),
  edges: z
    .array(z.tuple([z.string(), z.string()]))
    .max(MAX_WORKFLOW_EDGES, `workflow allows at most ${MAX_WORKFLOW_EDGES} edges`)
    .optional()
    .describe('[source, target] pairs: target waits for source and receives its report'),
  maxConcurrency: z
    .number()
    .int()
    .min(1)
    .max(MAX_WORKFLOW_NODES)
    .optional()
    .describe('Max nodes running in parallel; defaults to the node count'),
});

type WorkflowInput = z.infer<typeof workflowInputSchema>;

export interface WorkflowToolOptions {
  registry: AgentDefinitionRegistry;
  tools: readonly Tool[];
  intervention: InterventionHandler;
  projectInstructions: ProjectInstructions | undefined;
  config: AppConfig;
  createModel: (config: AppConfig) => Promise<Model>;
  /** Same registry as `subagent`: nodes surface on the existing dispatch rows. */
  dispatches?: SubagentDispatchRegistry;
  /** Shared portable hook policy; each node gets its own fork. */
  codexHooks?: CodexHookRunner;
  /** Test/diagnostic observer; receives each real child after initialization. */
  onChildInitialized?: (agent: Agent) => void;
}

/** Everything one node owns for one workflow run. */
interface WorkflowNode {
  readonly nodeId: string;
  readonly definition: AgentDefinition;
  readonly task: string;
  readonly dispatch: SubagentDispatchHandle | undefined;
  readonly codexHooks: CodexHookRunner | undefined;
  readonly child: Agent;
}

/**
 * Owns the parent's workflow tool and every transient child a DAG run creates.
 *
 * Like `SubagentTool`, this never uses SDK `Agent.asTool()` or forwards child
 * stream events to the parent: the graph consumes each child privately and only
 * terminus content returns. Parallel branches share one working tree with no
 * isolation, so the description pins the rule: reads may run in parallel,
 * writes must be serialized by edges.
 */
export class WorkflowTool {
  readonly tool: Tool;
  private config: AppConfig;
  private readonly activeAgents = new Set<Agent>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeExecutions = new Set<Promise<string>>();

  constructor(private readonly options: WorkflowToolOptions) {
    this.config = options.config;
    const catalogue = options.registry.definitions
      .map((definition) => `${definition.name}: ${definition.description}`)
      .join('; ');

    this.tool = tool({
      name: WORKFLOW_TOOL_NAME,
      description:
        'Execute a bounded declarative workflow: a DAG of subagent tasks scheduled by ' +
        'dependency order, where each [source, target] edge makes target wait for source ' +
        'and receive its final report as input. Input is data, never code. Concurrent ' +
        'nodes share one working tree: parallel branches are for READS ONLY; serialize ' +
        'writes by edges. Only bounded terminus reports are returned. ' +
        `Available agents: ${catalogue}`,
      inputSchema: workflowInputSchema,
      callback: (input, context) => this.track(input, context),
    });
  }

  /** Future workflow runs use this config; active children keep their models. */
  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  /** Cooperatively stops every active graph run and its children. */
  cancelActive(): void {
    for (const controller of this.activeControllers) controller.abort();
    for (const agent of this.activeAgents) agent.cancel();
  }

  /** Cancels active runs and waits for their per-node cleanup to finish. */
  async shutdown(): Promise<void> {
    this.cancelActive();
    await Promise.allSettled([...this.activeExecutions]);
  }

  private track(input: WorkflowInput, context?: ToolContext): Promise<string> {
    const execution = this.run(input, context);
    this.activeExecutions.add(execution);
    void execution.then(
      () => this.activeExecutions.delete(execution),
      () => this.activeExecutions.delete(execution),
    );
    return execution;
  }

  private async run(input: WorkflowInput, context?: ToolContext): Promise<string> {
    // Refuses before anything is constructed: an invalid DAG spawns zero
    // children, begins zero dispatches, and builds zero models.
    const definitions = this.validate(input);
    const edges = input.edges ?? [];

    // Snapshot the live config before async model construction; a concurrent
    // /model switch affects the next workflow, never a run already being built.
    const config = this.config;

    // One owned signal so cancelActive()/shutdown() and the parent's own
    // cancellation both stop scheduling; the SDK graph aborts running nodes and
    // never starts pending ones once it fires.
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const cancelRun = () => controller.abort();
    if (context?.agent.cancelSignal.aborted === true) controller.abort();
    else context?.agent.cancelSignal.addEventListener('abort', cancelRun, { once: true });

    const nodes: WorkflowNode[] = [];
    try {
      for (const node of input.nodes) {
        const definition = definitions.get(node.id) as AgentDefinition;
        // `toolUseId` deliberately omitted: every node of one workflow call
        // shares the parent tool_use id, and deriving dispatch ids from it would
        // collide — targeted `/agents cancel` must address exactly one child.
        const dispatch = this.options.dispatches?.begin({
          agentName: definition.name,
          task: node.task,
        });
        const model = await this.options.createModel(config);
        nodes.push({
          nodeId: node.id,
          definition,
          task: node.task,
          dispatch,
          codexHooks: this.options.codexHooks?.fork(),
          child: buildRecipeChild({
            definition,
            config,
            model,
            tools: this.options.tools,
            intervention: this.options.intervention,
            projectInstructions: this.options.projectInstructions,
            idPrefix: 'workflow',
            dispatch,
          }),
        });
      }

      // Cancellation may land during model construction, before the graph
      // exists. The finally sweep settles every dispatch as cancelled.
      if (controller.signal.aborted) return 'Workflow cancelled.';

      for (const node of nodes) this.activeAgents.add(node.child);
      const graph = new Graph({
        id: `darwin-workflow-${randomUUID()}`,
        nodes: nodes.map((node) => this.adapterFor(node)),
        edges: edges.map(([source, target]) => [source, target] as [string, string]),
        // A validated DAG executes each node at most once; this bounds the run
        // and keeps scheduling the SDK's, never Darwin's.
        maxSteps: nodes.length,
        maxConcurrency: input.maxConcurrency ?? nodes.length,
      });

      const result = await graph.invoke('', { cancelSignal: controller.signal });
      if (result.status === 'CANCELLED') return 'Workflow cancelled.';
      if (result.status !== 'COMPLETED') {
        const failures = result.results
          .filter((node) => node.status === 'FAILED')
          .map((node) => `${node.nodeId}: ${firstLine(node.error?.message ?? 'unknown error')}`)
          .join('; ');
        throw new Error(`Workflow ${result.status.toLowerCase()}${failures === '' ? '' : ` — ${failures}`}`);
      }
      const report = terminusText(result.content);
      return report === '' ? 'Workflow completed with no terminus report.' : report;
    } finally {
      context?.agent.cancelSignal.removeEventListener('abort', cancelRun);
      this.activeControllers.delete(controller);
      for (const node of nodes) {
        this.activeAgents.delete(node.child);
        // A dispatch still running here belongs to a node the graph never
        // started (upstream failure or cancellation): settle it visibly.
        node.dispatch?.finish('cancelled');
        node.codexHooks?.cancel();
      }
      await Promise.allSettled(
        nodes.flatMap((node) => [stopBashSession(node.child), node.codexHooks?.close() ?? Promise.resolve()]),
      );
    }
  }

  /**
   * The thin `InvokableAgent` seam between the SDK graph and one recipe child:
   * its id is the user's node id (so edges and `[node: <id>]` dependency labels
   * read as declared) while the inner Agent keeps a globally unique id for the
   * dispatch registry. `stream()` prepends this node's own task to whatever
   * dependency-merged input the SDK hands it — the merge itself stays the SDK's.
   */
  private adapterFor(node: WorkflowNode) {
    const self = this;
    return {
      id: node.nodeId,
      name: node.definition.name,
      description: node.definition.description,
      async invoke(args: InvokeArgs, options?: InvokeOptions): Promise<AgentResult> {
        const generator = self.streamNode(node, args, options);
        let next = await generator.next();
        while (!next.done) next = await generator.next();
        return next.value;
      },
      stream(args: InvokeArgs, options?: InvokeOptions): AsyncGenerator<StreamEvent, AgentResult, undefined> {
        return self.streamNode(node, args, options);
      },
    };
  }

  private async *streamNode(
    node: WorkflowNode,
    args: InvokeArgs,
    options?: InvokeOptions,
  ): AsyncGenerator<StreamEvent, AgentResult, undefined> {
    const { child, definition, dispatch, codexHooks } = node;
    // Targeted `/agents cancel` before the node started: never invoke the child.
    // The graph maps the synthetic result like any completed node, so siblings
    // and dependants continue — exactly one child was stopped.
    if (options?.cancelSignal?.aborted === true || dispatch?.cancellationRequested() === true) {
      dispatch?.finish('cancelled');
      return syntheticResult('Workflow node cancelled.');
    }

    try {
      await child.initialize();
      this.options.onChildInitialized?.(child);
      // Private per node, not the graph's shared reference: each child keeps its
      // own one-shot max-tokens recovery allowance, like a subagent dispatch.
      const invocationState: InvocationState = {};
      const hookContext = await codexHooks?.subagentStart({
        id: child.id,
        name: definition.name,
      });
      const input = composeNodeInput(node.task, hookContext, args);
      const invokeOptions: InvokeOptions = {
        invocationState,
        ...(options?.cancelSignal === undefined ? {} : { cancelSignal: options.cancelSignal }),
      };
      const result = yield* child.stream(input, invokeOptions);
      const outcome = result.stopReason === 'cancelled' ? 'cancelled' : 'succeeded';
      dispatch?.finish(outcome);
      // Child assistant text is private until it flows as bounded node content.
      // Do not duplicate it into a lifecycle command payload.
      void codexHooks?.subagentStop({ id: child.id, name: definition.name, outcome });
      return withRetainedResult(result, invocationState);
    } catch (error) {
      dispatch?.finish('failed');
      throw error;
    }
  }

  /** Bounded refusals, in input order; throws before any construction work. */
  private validate(input: WorkflowInput): Map<string, AgentDefinition> {
    const available = this.options.registry.definitions.map((definition) => definition.name).join(', ');
    const definitions = new Map<string, AgentDefinition>();
    for (const node of input.nodes) {
      if (node.task.trim() === '') throw new Error(`Node ${JSON.stringify(node.id)} has an empty task.`);
      if (definitions.has(node.id)) throw new Error(`Duplicate node id ${JSON.stringify(node.id)}.`);
      const requested = node.agent ?? DEFAULT_AGENT_NAME;
      const definition = this.find(requested);
      if (definition === undefined) {
        throw new Error(
          `Node ${JSON.stringify(node.id)} names unknown agent ${JSON.stringify(requested)}. ` +
          `Available agents: ${available}.`,
        );
      }
      definitions.set(node.id, definition);
    }

    const edges = input.edges ?? [];
    const seen = new Set<string>();
    for (const [source, target] of edges) {
      for (const endpoint of [source, target]) {
        if (!definitions.has(endpoint)) {
          throw new Error(
            `Edge ${JSON.stringify([source, target])} references unknown node id ${JSON.stringify(endpoint)}.`,
          );
        }
      }
      const key = `${JSON.stringify(source)}->${JSON.stringify(target)}`;
      if (seen.has(key)) throw new Error(`Duplicate edge ${JSON.stringify([source, target])}.`);
      seen.add(key);
    }

    // Kahn's algorithm — validation only. Execution order stays the SDK's.
    const indegree = new Map<string, number>([...definitions.keys()].map((id) => [id, 0]));
    for (const [, target] of edges) indegree.set(target, (indegree.get(target) ?? 0) + 1);
    const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift() as string;
      visited += 1;
      for (const [source, target] of edges) {
        if (source !== id) continue;
        const remaining = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, remaining);
        if (remaining === 0) queue.push(target);
      }
    }
    if (visited !== definitions.size) {
      const cyclic = [...indegree.entries()]
        .filter(([, degree]) => degree > 0)
        .map(([id]) => id)
        .join(', ');
      throw new Error(`Workflow edges form a cycle involving node(s): ${cyclic}.`);
    }
    return definitions;
  }

  private find(name: string): AgentDefinition | undefined {
    const normalized = name.trim().toLowerCase();
    return this.options.registry.definitions.find(
      (definition) => definition.name.toLowerCase() === normalized,
    );
  }
}

/**
 * Prepends the node's own task to the SDK-provided input. The graph-level input
 * is the empty string (per-node tasks live in the DAG, not the graph prompt),
 * so its placeholder text block is dropped; dependency-merged `[node: <id>]`
 * labels and upstream reports pass through untouched.
 */
function composeNodeInput(task: string, hookContext: string | undefined, args: InvokeArgs): InvokeArgs {
  const text = injectCodexContext(task, hookContext);
  if (typeof args === 'string') return args.trim() === '' ? text : `${text}\n\n${args}`;
  if (Array.isArray(args)) {
    // The graph hands dependency-merged ContentBlock instances here.
    const blocks = (args as ContentBlock[]).filter(
      (block) => !(block.type === 'textBlock' && block.text.trim() === ''),
    );
    return [new TextBlock(text), ...blocks];
  }
  return text;
}

/** Folds privately retained max-tokens partial text back into the node result. */
function withRetainedResult(result: AgentResult, invocationState: InvocationState): AgentResult {
  const plain = result.toString();
  const report = withRetainedMaxTokensText(plain, invocationState);
  if (report === plain) return result;
  return new AgentResult({
    stopReason: result.stopReason,
    lastMessage: new Message({ role: 'assistant', content: [new TextBlock(report)] }),
    invocationState,
    ...(result.metrics === undefined ? {} : { metrics: result.metrics }),
  });
}

function syntheticResult(text: string): AgentResult {
  return new AgentResult({
    stopReason: 'cancelled',
    lastMessage: new Message({ role: 'assistant', content: [new TextBlock(text)] }),
    invocationState: {},
  });
}

/** The SDK graph's own terminus content, projected to text for the tool result. */
function terminusText(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'textBlock')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

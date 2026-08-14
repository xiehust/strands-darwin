/**
 * Agent assembly. The only place that constructs the SDK `Agent`.
 *
 * The runtime is deliberately thin: it wires SDK pieces together and hands the
 * raw event stream to whatever is driving it. Callers (the dev REPL now, Ink
 * later) decide how to render.
 */
import { Agent, SummarizingConversationManager } from '@strands-agents/sdk';
import type { AgentStreamEvent, InterventionHandler, McpClient, Model } from '@strands-agents/sdk';
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor';

import { compactConversation, type CompactResult } from './compact.js';
import { loadAgentDefinitions } from '../agents/loader.js';
import { SubagentTool } from '../agents/subagent-tool.js';
import {
  expandCustomCommand,
  loadCustomCommands,
  type CustomCommandRegistry,
  type ExpandedCustomCommand,
} from '../commands/custom-commands.js';
import {
  appendAllowRule,
  applyThinkingEffort,
  createModelFromConfig,
  loadConfig,
  saveEnabledModel,
  saveThinkingEffort,
  withModelChoice,
  type AppConfig,
  type ModelChoice,
} from '../config.js';
import {
  BackgroundBashManager,
  createBackgroundBashTool,
  type BackgroundTaskListener,
  type BackgroundTaskStatus,
} from '../tools/background-bash.js';
import { ToolHookGate } from '../hooks/tool-hooks.js';
import { disconnectAll, loadMcpClients } from '../mcp/registry.js';
import { SkillsPlugin, expandSkillCommand, type ExpandedSkillCommand } from '../skills/plugin.js';
import {
  composeSystemPrompt,
  loadProjectInstructions,
  type ProjectInstructionsSummary,
} from './instructions.js';
import { PermissionGate, type ApprovalMode, type PermissionBridge } from './permission.js';
import { applySystemPromptCachePoint, planPromptCache, type PromptCachePlan } from './prompt-cache.js';
import { createModelClassifier } from './safety-classifier.js';
import { createSessionManager, resolveSession, writePointer } from './session.js';
import { loadSystemPrompt, type SystemPromptSource } from './system-prompt.js';
import { planThinking, type ThinkingEffort, type ThinkingPlan } from './thinking.js';

/**
 * Stable across runs by necessity: session snapshots are stored under
 * `<sessionId>/scopes/agent/<agentId>/`, so a changing agent id would hide
 * previous snapshots from `--resume`.
 */
const AGENT_ID = 'darwin';

export interface RuntimeOptions {
  projectRoot: string;
  /** Continue the previous session instead of starting a new one. */
  resume: boolean;
  /** Asks the user to approve write and execute tool calls. */
  permissionBridge: PermissionBridge;
  /** Overrides the config's `permissionMode` (CLI flags win over the file). */
  permissionModeOverride?: ApprovalMode;
}

/**
 * Cumulative token counts, in the four buckets Bedrock bills separately: fresh
 * input, cache reads, cache writes, and output.
 */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

export type { CompactResult } from './compact.js';

/**
 * The outcome of an `/effort` change: what the model will now do, and a promise
 * for the attempt to remember it in `.darwin/config.json`.
 *
 * The write is handed back unawaited on purpose — see
 * {@link AgentRuntime.changeThinkingEffort}.
 */
export interface ThinkingChangeResult {
  plan: ThinkingPlan;
  saved: Promise<void>;
}

/**
 * The outcome of a `/model` change: which configuration is now live, what it can
 * cache, how hard it will think — and a promise for the attempt to remember the
 * switch in `.darwin/config.json`.
 *
 * The cache and thinking plans come back because both are model-dependent: the
 * new model may not cache at all, and it may not serve the effort level the old
 * one did. Reporting that is the point; discovering it on the next turn is not.
 */
export interface ModelChangeResult {
  choice: ModelChoice;
  thinking: ThinkingPlan;
  promptCache: PromptCachePlan;
  saved: Promise<void>;
}
export type ExpandedSlashCommand =
  | ({ kind: 'skill' } & ExpandedSkillCommand)
  | ({ kind: 'command' } & ExpandedCustomCommand);

export interface RuntimeInfo {
  config: AppConfig;
  /** Effective approval mode after CLI overrides. */
  permissionMode: ApprovalMode;
  sessionId: string;
  resumed: boolean;
  /** Names of skills discovered under `.darwin/skills/`. */
  skillNames: string[];
  /** Skill directories that were skipped, with the reason. */
  skillProblems: { directory: string; reason: string }[];
  /** Names of custom prompts discovered under `.darwin/commands/`. */
  commandNames: string[];
  /** Custom command files that were skipped, with the reason. */
  commandProblems: { file: string; reason: string }[];
  /** Built-in and project-defined child agents available to the delegation tool. */
  agentNames: string[];
  /** Project agent files that were skipped, with the reason. */
  agentProblems: { file: string; reason: string }[];
  /** AGENTS.md preloaded from the run directory, or undefined when there is none. */
  projectInstructions: ProjectInstructionsSummary | undefined;
  /** Why a present AGENTS.md was skipped; undefined when there is no such file. */
  projectInstructionsProblem: string | undefined;
  /** Where the base system prompt came from: built-in, config, or override file. */
  systemPromptSource: SystemPromptSource;
  /** Path of the system prompt override file, when one is in effect. */
  systemPromptPath: string | undefined;
  /** Why a present system prompt override was skipped; undefined when there is none. */
  systemPromptProblem: string | undefined;
  /** What this run caches, or why it caches nothing. */
  promptCache: PromptCachePlan;
  /**
   * How hard the model thinks at startup, and why that differs from the config
   * when it does. Only the startup value: the live one moves with `/effort`, so
   * read {@link AgentRuntime.thinking} for that.
   */
  thinking: ThinkingPlan;
  /** Path to the MCP config that was read, or undefined when there is none. */
  mcpConfigPath: string | undefined;
  /** Root `.mcp.json` left unread because `.darwin/mcp.json` took precedence. */
  mcpIgnoredConfigPath: string | undefined;
  /** Number of MCP servers configured (some may have failed to connect). */
  mcpServerCount: number;
  /** Agent-facing names of every tool registered, MCP tools included. */
  toolNames: string[];
}

export class AgentRuntime {
  /**
   * The live thinking plan. Mutable, unlike everything in {@link RuntimeInfo}:
   * `/effort` changes it mid-session by reconfiguring the model in place.
   */
  private thinkingPlan: ThinkingPlan;

  /**
   * The config in effect right now. Diverges from `info.config` after `/model`:
   * `info` is the startup snapshot, this moves with the session.
   */
  private liveConfig: AppConfig;

  /** What the live model can cache. Recomputed on `/model`, like the plan above. */
  private promptCachePlan: PromptCachePlan;

  private constructor(
    private readonly agent: Agent,
    // Not readonly: `/model` replaces it, which is also why `Agent.model` being a
    // mutable property matters — the conversation survives a provider change.
    private model: Model,
    private readonly projectRoot: string,
    private readonly mcpClients: readonly McpClient[],
    private readonly skills: SkillsPlugin,
    private readonly commands: CustomCommandRegistry,
    private readonly subagents: SubagentTool,
    private readonly backgroundBash: BackgroundBashManager,
    private readonly gate: PermissionGate,
    private readonly compactionManager: SummarizingConversationManager,
    private readonly preserveRecentMessages: number,
    readonly info: RuntimeInfo,
  ) {
    this.thinkingPlan = info.thinking;
    this.liveConfig = info.config;
    this.promptCachePlan = info.promptCache;
  }

  static async create(options: RuntimeOptions): Promise<AgentRuntime> {
    const config = await loadConfig(options.projectRoot);
    const model = await createModelFromConfig(config);
    const session = await resolveSession(options.projectRoot, options.resume);
    const skills = await SkillsPlugin.load(options.projectRoot);
    const commands = await loadCustomCommands(
      options.projectRoot,
      skills.skills.map((skill) => skill.name),
    );
    const loadedInstructions = await loadProjectInstructions(options.projectRoot);
    const instructions = loadedInstructions.instructions;
    const basePrompt = await loadSystemPrompt(options.projectRoot, config.systemPrompt);
    const mcp = await loadMcpClients(options.projectRoot);

    const permissionMode = options.permissionModeOverride ?? config.permissionMode;
    const gate = new PermissionGate({
      mode: permissionMode,
      projectRoot: options.projectRoot,
      ask: options.permissionBridge,
      allowRules: config.permissionRules?.allow ?? [],
      // Only auto consults it; constructing it is free (the model is lazy).
      ...(permissionMode === 'auto' && {
        classifier: createModelClassifier(config, options.projectRoot),
      }),
    });

    // No configured hooks means the exact pre-existing handler is registered and
    // no shell process can be spawned. Otherwise one composed handler preserves
    // Pre → permission → tool → Post ordering for both parent and child agents.
    const intervention: InterventionHandler = config.hooks === undefined
      ? gate
      : new ToolHookGate(options.projectRoot, config.hooks, gate);

    const sessionManager = createSessionManager(options.projectRoot, session.sessionId);
    // One manager and wrapper are shared by the main Agent and every child tool
    // catalogue. Foreground calls still delegate with the caller's ToolContext.
    const backgroundBash = new BackgroundBashManager(options.projectRoot, session.sessionId);
    const bash = createBackgroundBashTool(backgroundBash);
    const conversationManager = new SummarizingConversationManager({
      summaryRatio: config.summaryRatio,
      preserveRecentMessages: config.preserveRecentMessages,
    });
    // `/compact` has a different target from overflow recovery: collapse every
    // reducible old message in one command, leaving one summary plus the recent
    // window. A ratio of 0.8 is the SDK's maximum and minimizes model calls.
    const compactionManager = new SummarizingConversationManager({
      summaryRatio: 0.8,
      preserveRecentMessages: config.preserveRecentMessages,
    });
    const agent = new Agent({
      id: AGENT_ID,
      model,
      // AGENTS.md is folded in here; the skills catalogue is appended afterwards
      // by SkillsPlugin.initAgent during initialize(), keeping the assembled
      // prompt in a fixed order. Only the base is user-overridable: the project's
      // own instructions are appended to whichever base is in effect.
      systemPrompt: composeSystemPrompt(basePrompt.prompt, instructions),
      // McpClient instances act as tool sources: the SDK discovers and registers
      // their tools during initialize().
      tools: [bash, fileEditor, ...mcp.clients],
      plugins: [skills],
      sessionManager,
      conversationManager,
      interventions: [intervention],
      // Required: the SDK's own printer writes to stdout and would interleave
      // with our rendering (and fight Ink for the terminal in step 5).
      printer: false,
    });

    // The constructor does not initialize; the SDK defers it to the first
    // invocation. Session restore runs on InitializedEvent, MCP tools are
    // discovered here, and plugins inject their system prompt fragments — so
    // without this the resumed history and MCP tools would not exist yet.
    await agent.initialize();

    // Child tool allowlists can include MCP and plugin tools, whose final names do
    // not exist until initialization. Capture that catalogue before registering
    // `subagent` so children can never recursively delegate.
    const childTools = agent.tools;
    const agentDefinitions = await loadAgentDefinitions(
      options.projectRoot,
      childTools.map((tool) => tool.name),
    );
    const subagents = new SubagentTool({
      registry: agentDefinitions,
      tools: childTools,
      intervention,
      projectInstructions: instructions,
      config,
      createModel: createModelFromConfig,
    });
    agent.toolRegistry.add(subagents.tool);

    // Strictly after initialize(): the skills catalogue is appended during it, and
    // the cache point has to sit at the very end of the finished prompt (the skills
    // plugin also refuses to append to a block-array prompt). Tools and the
    // conversation are cached by the model's own cacheConfig, set in config.ts.
    const promptCache = planPromptCache(config);
    applySystemPromptCachePoint(agent, promptCache);

    return new AgentRuntime(
      agent,
      model,
      options.projectRoot,
      mcp.clients,
      skills,
      commands,
      subagents,
      backgroundBash,
      gate,
      compactionManager,
      config.preserveRecentMessages,
      {
        config,
        permissionMode,
        sessionId: session.sessionId,
        resumed: session.resumed,
        skillNames: skills.skills.map((skill) => skill.name),
        skillProblems: skills.problems.map((problem) => ({ ...problem })),
        commandNames: commands.commands.map((command) => command.name),
        commandProblems: commands.problems.map((problem) => ({ ...problem })),
        agentNames: agentDefinitions.definitions.map((definition) => definition.name),
        agentProblems: agentDefinitions.problems.map((problem) => ({ ...problem })),
        projectInstructions:
          instructions === undefined
            ? undefined
            : { path: instructions.path, bytes: instructions.bytes, truncated: instructions.truncated },
        projectInstructionsProblem: loadedInstructions.problem,
        systemPromptSource: basePrompt.source,
        systemPromptPath: basePrompt.path,
        systemPromptProblem: basePrompt.problem,
        promptCache,
        // Recomputed rather than returned from createModelFromConfig: the model
        // factory needs only the fields, while the header needs the reason a level
        // was clamped. Both come from the same pure planner, so they cannot disagree.
        thinking: planThinking(config),
        mcpConfigPath: mcp.configPath,
        mcpIgnoredConfigPath: mcp.ignoredConfigPath,
        mcpServerCount: mcp.clients.length,
        toolNames: agent.tools.map((tool) => tool.name).sort(),
      },
    );
  }

  /**
   * Runs one turn, yielding SDK stream events untouched so callers can render
   * whichever ones they care about.
   */
  async *send(input: string): AsyncIterable<AgentStreamEvent> {
    yield* this.agent.stream(input);
  }

  /**
   * Replaces old conversation history with rolling summaries, keeping the recent
   * configured window verbatim, then persists the rewritten session immediately.
   *
   * This is deliberately a direct conversation-manager call, not an agent turn:
   * `/compact` must not become part of the context it is trying to shrink. The
   * original messages are cloned so any model/count/storage failure can put the
   * live agent back exactly where it started.
   */
  async compact(): Promise<CompactResult> {
    try {
      return await compactConversation({
        agent: this.agent,
        model: this.model,
        manager: this.compactionManager,
        preserveRecentMessages: this.preserveRecentMessages,
        persist: async () => {
          await this.agent.sessionManager?.saveSnapshot({ target: this.agent, isLatest: true });
          await this.markResumable();
        },
      });
    } catch (error) {
      // compactConversation has already restored the live messages. If saving the
      // compact snapshot succeeded but the pointer write failed, overwrite latest
      // with that restored state too, so disk and memory cannot diverge.
      try {
        await this.agent.sessionManager?.saveSnapshot({ target: this.agent, isLatest: true });
      } catch {
        // Preserve the original failure; this repair is necessarily best-effort.
      }
      throw error;
    }
  }

  /** Messages restored from a resumed session, for showing prior context. */
  get messageCount(): number {
    return this.agent.messages.length;
  }

  /**
   * How many wildcard allow-rules are in effect right now — config plus anything
   * accepted this session. Read live from the gate rather than snapshotted into
   * `info`, which is fixed at startup.
   */
  get allowRuleCount(): number {
    return this.gate.allowRules.length;
  }

  /**
   * Persists a rule the user accepted in a confirmation prompt. The gate is
   * already honouring it (it came back on the decision), so a rejected write only
   * costs the memory of it in the next session — which is why this throws instead
   * of swallowing: the caller reports it to the user.
   */
  async saveAllowRule(rule: string): Promise<void> {
    this.gate.addAllowRule(rule);
    await appendAllowRule(this.projectRoot, rule);
  }

  /** How hard the model is thinking right now, and why that is not what was asked. */
  get thinking(): ThinkingPlan {
    return this.thinkingPlan;
  }

  /**
   * Switches the effort level for the rest of the session and remembers it in
   * `.darwin/config.json`.
   *
   * The model is reconfigured before the file is written, and the new plan is
   * returned rather than awaited alongside the write: an effort change must take
   * effect on the very next turn, so a slow or failing disk cannot be allowed to
   * hold it up. A rejected write therefore means "this session only", which is why
   * it rethrows through {@link ThinkingChangeResult.saved} instead of being
   * swallowed — the caller says so.
   *
   * Only ever `adaptive` → `adaptive`, so this does not invalidate the conversation
   * cache breakpoint (switching thinking *modes* would).
   */
  changeThinkingEffort(effort: ThinkingEffort): ThinkingChangeResult {
    this.thinkingPlan = applyThinkingEffort(this.model, this.liveConfig, effort);
    return {
      plan: this.thinkingPlan,
      saved: saveThinkingEffort(this.projectRoot, effort),
    };
  }

  /** The config in effect now — the startup one until `/model` changes it. */
  get config(): AppConfig {
    return this.liveConfig;
  }

  /** What this run can cache right now; moves with `/model`. */
  get promptCache(): PromptCachePlan {
    return this.promptCachePlan;
  }

  /** Every configured model, with the live one marked. */
  get modelChoices(): readonly ModelChoice[] {
    return this.liveConfig.modelChoices;
  }

  /**
   * Switches the live model to another configured entry, keeping the conversation.
   *
   * `Agent.model` is a mutable property, so this replaces the model in place
   * instead of rebuilding the agent — which is the whole point: the history, the
   * session file, the tools and the permission gate all survive. Both switch
   * directions were measured to carry a conversation containing tool calls
   * (`spike/probe-model-switch.ts`); a Claude reasoning block in the history is
   * dropped with a warning by the OpenAI adapter rather than rejected, which is
   * why the TUI routes SDK warnings into notices.
   *
   * The thinking and cache plans are recomputed rather than carried over: effort
   * clamping is per-model and caching is per-provider, so the old plans would
   * describe a model that is no longer there.
   */
  async changeModel(target: ModelChoice): Promise<ModelChangeResult> {
    const next = withModelChoice(this.liveConfig, target);
    // Built before anything is mutated: a failure here (a missing peer dependency,
    // a bad region) must leave the session on the model it was already using.
    const model = await createModelFromConfig(next);

    this.agent.model = model;
    this.model = model;
    this.liveConfig = next;
    this.subagents.updateConfig(next);
    this.thinkingPlan = planThinking(next);
    this.promptCachePlan = planPromptCache(next);
    // Adds the system-prompt cache point when the new model can cache and the old
    // one could not. Already-placed points are left alone — the helper refuses a
    // non-string prompt — and a stale point costs nothing: a provider that cannot
    // cache ignores the block (measured in probe-model-switch.ts).
    applySystemPromptCachePoint(this.agent, this.promptCachePlan);

    const choice = next.modelChoices.find((entry) => entry.index === target.index) as ModelChoice;
    return {
      choice,
      thinking: this.thinkingPlan,
      promptCache: this.promptCachePlan,
      saved: saveEnabledModel(this.projectRoot, target.index),
    };
  }

  /**
   * Token totals for every model call this agent has made so far.
   *
   * Read live from the SDK's meter rather than tallied from stream events:
   * `accumulatedUsage` is a lifetime accumulator (see
   * `.trellis/spec/backend/strands-sdk-contracts.md`), so it is already the
   * running total and is readable between turns, including after a cancelled one
   * that never produced an `agentResultEvent`.
   *
   * Counts this process only. Sessions persist messages, not metrics, so a
   * `--resume`d session starts from zero however much it spent before — callers
   * that show these numbers should say so.
   */
  get usage(): UsageTotals {
    const usage = this.agent.metrics.accumulatedUsage;
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      // Optional on the SDK type: a provider that reports no caching omits them.
      cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
      cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
    };
  }

  /** Current-process background tasks, without creating an agent tool call. */
  listBackgroundTasks(): Promise<BackgroundTaskStatus[]> {
    return this.backgroundBash.list();
  }

  /** Publishes future terminal task snapshots until the returned closure is called. */
  subscribeToBackgroundTasks(listener: BackgroundTaskListener): () => void {
    return this.backgroundBash.subscribe(listener);
  }

  /**
   * Asks the agent to stop the current turn at its next safe point. The stream
   * ends with `stopReason: 'cancelled'` rather than throwing.
   */
  cancel(): void {
    this.subagents.cancelActive();
    this.agent.cancel();
  }

  /**
   * Records this session as the one `--resume` should reopen. Called after a turn
   * completes, so an unused session never displaces a useful one.
   */
  async markResumable(): Promise<void> {
    await writePointer(this.projectRoot, this.info.sessionId);
  }

  /**
   * Expands a skill or project command into the prompt sent to the model.
   * Skills are checked first as a defensive backstop to the loader's collision
   * filtering. Unknown slash input remains ordinary user input.
   */
  async expandSlashCommand(input: string): Promise<ExpandedSlashCommand | null> {
    const skill = await expandSkillCommand(this.skills, input);
    if (skill !== null) return { kind: 'skill', ...skill };

    const command = expandCustomCommand(this.commands, input);
    return command === null ? null : { kind: 'command', ...command };
  }

  /**
   * Releases every child process the session owns. Must run on exit: both the
   * bash shell and stdio MCP servers are spawned subprocesses whose open pipes
   * keep the event loop alive, so skipping this hangs the process instead of
   * exiting.
   */
  async shutdown(): Promise<void> {
    await Promise.allSettled([
      this.subagents.shutdown(),
      this.backgroundBash.shutdown(),
      this.stopBashSession(),
      disconnectAll(this.mcpClients),
    ]);
  }

  /**
   * Kills the persistent bash shell the vended `bash` tool keeps per agent.
   *
   * The SDK registers a `beforeExit` handler to do this, but `beforeExit` only
   * fires once the event loop is empty — and the shell's own stdio pipes are what
   * keep it non-empty, so that handler never runs and the process hangs forever
   * after any command has been executed.
   *
   * `mode: 'restart'` is the public way to reach the session: it stops the running
   * shell and installs a fresh one that is only spawned on the next command, so
   * nothing is left holding the loop open. The call is made directly (bypassing
   * the model loop) with history recording off, so it neither prompts for
   * permission nor appears in the conversation.
   */
  private async stopBashSession(): Promise<void> {
    const bashTool = this.agent.tool['bash'];
    if (bashTool === undefined) return;

    try {
      await bashTool.invoke({ mode: 'restart' }, { recordDirectToolCall: false });
    } catch {
      // Shutdown is best-effort: a failure here must not stop MCP cleanup or
      // prevent the process from exiting.
    }
  }
}

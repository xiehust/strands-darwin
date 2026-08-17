/**
 * Agent assembly. The only place that constructs the SDK `Agent`.
 *
 * The runtime is deliberately thin: it wires SDK pieces together and hands the
 * raw event stream to whatever is driving it. Callers (the dev REPL now, Ink
 * later) decide how to render.
 */
import { Agent, BeforeInvocationEvent, SummarizingConversationManager } from '@strands-agents/sdk';
import type { AgentStreamEvent, InterventionHandler, McpClient, Model } from '@strands-agents/sdk';
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor';
import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader';
import { LocalFileStorage } from '@strands-agents/sdk/storage';
import path from 'node:path';

import { compactConversation, countConversationTokens, type CompactResult } from './compact.js';
import { DiagnosticsLog, type DiagnosticsStatus } from './diagnostics.js';
import { installMaxTokensRecovery } from './max-tokens-recovery.js';
import { loadAgentDefinitions } from '../agents/loader.js';
import {
  SubagentDispatchRegistry,
  type SubagentDispatchListener,
  type SubagentDispatchStatus,
} from '../agents/dispatch-registry.js';
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
  loadProjectPolicy,
  permissionRulesPath,
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
import { createImageViewerTool } from '../tools/image-viewer.js';
import { ToolHookGate } from '../hooks/tool-hooks.js';
import { disconnectAll, loadMcpClients } from '../mcp/registry.js';
import { SkillsPlugin, expandSkillCommand, type ExpandedSkillCommand } from '../skills/plugin.js';
import { orderOfficialSkillsPrompt } from '../skills/prompt.js';
import { recordStream } from '../trajectory/stream.js';
import { TrajectoryRecorder, type TrajectoryStatus } from '../trajectory/writer.js';
import { DARWIN_VERSION } from '../version.js';
import {
  composeSystemPrompt,
  loadProjectInstructions,
  type ProjectInstructionsSummary,
} from './instructions.js';
import { PermissionGate, type ApprovalMode, type PermissionBridge } from './permission.js';
import {
  applySystemPromptCachePoint,
  canUpdateSystemPromptCache,
  planPromptCache,
  type PromptCachePlan,
} from './prompt-cache.js';
import { createModelClassifier } from './safety-classifier.js';
import {
  createSessionManager,
  diagnosticsPath,
  resolveSession,
  sessionPaths,
  trajectoryPath,
  writePointer,
  type SessionSelector,
} from './session.js';
import { setSdkVerboseSink } from './sdk-logging.js';
import { loadSystemPrompt, type SystemPromptSource } from './system-prompt.js';
import { applyWorkingContext, buildWorkingContext } from './working-context.js';
import { planThinking, type ThinkingEffort, type ThinkingPlan } from './thinking.js';
import { deltaUsage, startTurnSpend, type UsageTotals } from './usage.js';

/** Test seam for proving startup unwind after resources have been acquired. */
type RuntimeCreateCheckpoint = 'after-initialize';
let runtimeCreateCheckpoint: ((checkpoint: RuntimeCreateCheckpoint) => void) | undefined;

export function setRuntimeCreateCheckpointForTest(
  callback: ((checkpoint: RuntimeCreateCheckpoint) => void) | undefined,
): void {
  runtimeCreateCheckpoint = callback;
}

/**
 * Stable across runs by necessity: session snapshots are stored under
 * `<sessionId>/scopes/agent/<agentId>/`, so a changing agent id would hide
 * previous snapshots from `--resume`.
 */
const AGENT_ID = 'darwin';

export interface RuntimeOptions {
  projectRoot: string;
  /** Conversation to create or restore. */
  session: SessionSelector;
  /** Called once the effective id is known, before provider startup. */
  onSessionResolved?: (sessionId: string) => void;
  /** Suppress unbounded MCP subprocess banners in the headless stderr protocol. */
  quietMcpStderr?: boolean;
  /** Asks the user to approve write and execute tool calls. */
  permissionBridge: PermissionBridge;
  /** Overrides the config's `permissionMode` (CLI flags win over the file). */
  permissionModeOverride?: ApprovalMode;
}

export type { CompactResult } from './compact.js';
export type { UsageTotals } from './usage.js';

/**
 * The outcome of an `/effort` change: what the model will now do, and a promise
 * for the attempt to remember it in `~/.darwin/config.json`.
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
 * switch in `~/.darwin/config.json`.
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

/** Estimated size of the next request's context, plus the model's window. */
export interface ContextEstimate {
  /** Heuristic token count over messages, system prompt, and tool schemas. */
  estimatedTokens: number;
  messageCount: number;
  /** The model's context window, when the SDK knows it for this model id. */
  windowTokens: number | undefined;
}

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
  /**
   * Why the working context carries no directory listing. Undefined in the normal
   * case: the rest of the block (directory, platform, date) is always sent.
   */
  workingContextProblem: string | undefined;
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
  /** Every MCP config layer that contributed servers. */
  mcpConfigPaths: string[];
  /** Project server names that replaced global definitions. */
  mcpOverriddenServerNames: string[];

  /** Root `.mcp.json` left unread because `.darwin/mcp.json` took precedence. */
  /** Project-scoped user-state file where accepted allow rules persist. */
  permissionRulesPath: string;
  /** Active global/project hook source files, in policy order. */
  hookSources: string[];

  mcpIgnoredConfigPath: string | undefined;
  /** Number of MCP servers configured (some may have failed to connect). */
  mcpServerCount: number;
  /** Agent-facing names of every tool registered, MCP tools included. */
  toolNames: string[];
  /**
   * Where this session's append-only trajectory is recorded, or undefined when
   * `trajectory: false` switched recording off. Reported rather than assumed: the
   * whole point of the record is that something else can read it later.
   */
  trajectoryFile: string | undefined;
  /**
   * Where this session's diagnostics are written, or undefined when `diagnostics` is
   * off — which is the default. Reported so the TUI can say where the file is in one
   * transcript notice: a log nobody can find is a log nobody reads, and the header
   * contract forbids spending a frame row on it.
   */
  diagnosticsFile: string | undefined;
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

  private lastTurnDelta: UsageTotals | undefined = undefined;

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
    private readonly subagentDispatches: SubagentDispatchRegistry,
    private readonly backgroundBash: BackgroundBashManager,
    private readonly gate: PermissionGate,
    private readonly compactionManager: SummarizingConversationManager,
    private readonly preserveRecentMessages: number,
    /** Undefined when `trajectory: false` switched recording off for this run. */
    private readonly trajectory: TrajectoryRecorder | undefined,
    /** Undefined unless `diagnostics: true` asked for the log. Off is the default. */
    private readonly diagnosticsLog: DiagnosticsLog | undefined,
    readonly info: RuntimeInfo,
  ) {
    this.thinkingPlan = info.thinking;
    this.liveConfig = info.config;
    this.promptCachePlan = info.promptCache;
  }

  /**
   * Releases startup-owned observers and external clients when construction fails.
   * Successful creation transfers the same resources to `shutdown()` instead.
   */
  static async unwindCreate(
    diagnosticsLog: DiagnosticsLog | undefined,
    mcpClients: readonly McpClient[] = [],
    backgroundBash?: BackgroundBashManager,
  ): Promise<void> {
    if (diagnosticsLog !== undefined) setSdkVerboseSink(undefined);
    await Promise.allSettled([
      disconnectAll(mcpClients),
      backgroundBash?.shutdown() ?? Promise.resolve(),
      diagnosticsLog?.close() ?? Promise.resolve(),
    ]);
  }

  static async create(options: RuntimeOptions): Promise<AgentRuntime> {
    // Resolve explicit ids before provider/model construction: a bad automation
    // selector must fail locally without initializing anything billable.
    const session = await resolveSession(options.projectRoot, options.session, AGENT_ID);
    options.onSessionResolved?.(session.sessionId);
    const config = await loadConfig(options.projectRoot);
    const policy = await loadProjectPolicy(options.projectRoot);
    // Built here, before the model, the MCP clients and the skills plugin, because all
    // three log at `debug` while they start up (MCP tool renames, skill discovery) and
    // a diagnostics log that begins after startup cannot answer a question about
    // startup. It opens no file yet: the first line is buffered, so a session that
    // never logs again still leaves nothing behind. Installing the tap is what makes
    // the SDK's `debug`/`info` reach anything at all — with `diagnostics` off they stay
    // the literal no-ops `sdk-logging.ts` installs, and no line is ever formatted.
    const diagnosticsLog =
      config.diagnostics === true
        ? new DiagnosticsLog({
            file: diagnosticsPath(options.projectRoot, session.sessionId),
            run: {
              session: session.sessionId,
              darwinVersion: DARWIN_VERSION,
              provider: config.provider,
              model: config.model,
            },
          })
        : undefined;
    if (diagnosticsLog !== undefined) setSdkVerboseSink(diagnosticsLog.sdkSink);
    let startupMcpClients: readonly McpClient[] = [];
    let startupBackgroundBash: BackgroundBashManager | undefined;

    // Keep assembly in one function so one catch owns every resource acquired
    // after the process-global diagnostics tap is installed.
    const assemble = async (): Promise<AgentRuntime> => {
    const model = await createModelFromConfig(config);
    const skills = await SkillsPlugin.load(options.projectRoot);
    const commands = await loadCustomCommands(
      options.projectRoot,
      skills.skills.map((skill) => skill.name),
    );
    const loadedInstructions = await loadProjectInstructions(options.projectRoot);
    const instructions = loadedInstructions.instructions;
    const basePrompt = await loadSystemPrompt(options.projectRoot, config.systemPrompt);
    const mcp = await loadMcpClients(options.projectRoot, {
      quietStdioStderr: options.quietMcpStderr === true,
    });
    startupMcpClients = mcp.clients;

    const permissionMode = options.permissionModeOverride ?? config.permissionMode;
    // Built before the gate on purpose: the gate must resolve provenance for
    // children that do not exist yet, and only the narrow resolver crosses over —
    // the permission layer never learns about the delegation tool itself.
    const subagentDispatches = new SubagentDispatchRegistry();
    const gate = new PermissionGate({
      mode: permissionMode,
      projectRoot: options.projectRoot,
      ask: options.permissionBridge,
      allowRules: policy.allowRules,
      dispatchSource: (agentId) => subagentDispatches.sourceFor(agentId),
      // Only auto consults it; constructing it is free (the model is lazy).
      ...(permissionMode === 'auto' && {
        classifier: createModelClassifier(config, options.projectRoot),
      }),
    });

    // No configured hooks means the exact pre-existing handler is registered and
    // no shell process can be spawned. Otherwise one composed handler preserves
    // Pre → permission → tool → Post ordering for both parent and child agents.
    const intervention: InterventionHandler = policy.hooks === undefined
      ? gate
      : new ToolHookGate(options.projectRoot, policy.hooks, gate);

    const sessionManager = createSessionManager(options.projectRoot, session.sessionId);
    // One manager and wrapper are shared by the main Agent and every child tool
    // catalogue. Foreground calls still delegate with the caller's ToolContext.
    const backgroundBash = new BackgroundBashManager(options.projectRoot, session.sessionId);
    startupBackgroundBash = backgroundBash;
    const bash = createBackgroundBashTool(backgroundBash);
    const imageViewer = createImageViewerTool(options.projectRoot);
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
    // Off by default. Storage is session-scoped and on disk, next to the
    // background-task logs, so a reference the model holds still resolves after
    // `--resume`; `evictAfterCycles: null` disables eviction for the same reason
    // — a resumed conversation can cite a reference from many cycles ago. The
    // corollary is that offload files accumulate unbounded: nothing in darwin
    // deletes session state today (there is no session GC to align with), so the
    // bound is manual — delete a finished session's directories, as documented
    // on `contextOffload` in config.ts. Do not add per-session cleanup here: a
    // fresh session id is timestamp-unique, so its offload dir never pre-exists,
    // and any other session's dir may still be resumed.
    const offloader =
      config.contextOffload === true
        ? new ContextOffloader({
            storage: new LocalFileStorage(
              path.join(sessionPaths(options.projectRoot).sessionsDir, session.sessionId, 'offload'),
            ),
            evictAfterCycles: null,
            ...(config.maxResultTokens !== undefined && { maxResultTokens: config.maxResultTokens }),
          })
        : undefined;

    const agent = new Agent({
      id: AGENT_ID,
      model,
      // AGENTS.md is folded in here. Official AgentSkills injects its catalogue
      // before each invocation; the post-plugin hook below restores Darwin's fixed
      // order. Only the base is user-overridable: project instructions stay additive.
      systemPrompt: composeSystemPrompt(basePrompt.prompt, instructions),
      // McpClient instances act as tool sources: the SDK discovers and registers
      // their tools during initialize().
      tools: [bash, fileEditor, imageViewer, ...mcp.clients],
      plugins: offloader === undefined ? [skills] : [skills, offloader],
      sessionManager,
      conversationManager,
      interventions: [intervention],
      // Required: the SDK's own printer writes to stdout and would interleave
      // with our rendering (and fight Ink for the terminal in step 5).
      printer: false,
    });
    installMaxTokensRecovery(agent);

    // The constructor does not initialize; the SDK defers it to the first
    // invocation. Session restore runs on InitializedEvent, MCP tools are
    // discovered here, and plugins inject their system prompt fragments — so
    // without this the resumed history and MCP tools would not exist yet.
    await agent.initialize();

    // Official AgentSkills injects its catalogue on BeforeInvocationEvent. This
    // callback is registered afterwards, so it moves that official TextBlock
    // ahead of current working context and Darwin's final cache point before the
    // model sees the request. Repeated and resumed calls keep one catalogue: the
    // official callback removes its previous exact block first.
    agent.addHook(BeforeInvocationEvent, ({ agent: invokingAgent }) => {
      if (!orderOfficialSkillsPrompt(invokingAgent)) {
        throw new Error('Could not place the official skills catalogue before working context and cache.');
      }
    });

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
      dispatches: subagentDispatches,
    });
    agent.toolRegistry.add(subagents.tool);

    // Strictly after initialize(): session restore may have replaced both prompt
    // and official skill appState. Refresh current facts, then place the final
    // cache point. On invocation, official AgentSkills injects one catalogue and
    // Darwin's later hook moves it before these two trailing blocks. Tools and the
    // conversation are cached by the model's own cacheConfig, set in config.ts.
    //
    // The working context is refreshed here for a second reason: restoring a
    // session overwrites `systemPrompt` with the snapshot's copy, so composing it
    // earlier would leave a resumed run advertising the previous run's date and
    // directory listing. Applied last, it is also the only fragment a resumed
    // prompt can still be corrected by.
    const workingContext = await buildWorkingContext(options.projectRoot);
    if (!applyWorkingContext(agent, workingContext.fragment)) {
      throw new Error('Could not refresh working context on the restored system prompt.');
    }
    const promptCache = planPromptCache(config);
    if (promptCache.parts.includes('system prompt') && !applySystemPromptCachePoint(agent, promptCache)) {
      throw new Error('Could not place the final cache point on the assembled system prompt.');
    }
    runtimeCreateCheckpoint?.('after-initialize');

    // Built last and given nothing but facts: the recorder is an observer, so it
    // must not be able to influence assembly. It opens no file here — the first
    // recorded turn creates it, so a session that never runs one leaves nothing
    // behind, the same rule `markResumable()` follows for the resume pointer.
    const thinkingPlan = planThinking(config);
    const trajectory =
      config.trajectory === false
        ? undefined
        : new TrajectoryRecorder({
            file: trajectoryPath(options.projectRoot, session.sessionId),
            run: {
              session: session.sessionId,
              agentId: AGENT_ID,
              darwinVersion: DARWIN_VERSION,
              provider: config.provider,
              model: config.model,
              permissionMode,
              thinkingEffort: thinkingPlan.effective,
              resumed: session.restoreRequested && agent.messages.length > 0,
              restoredMessages: agent.messages.length,
            },
          });

    const runtime = new AgentRuntime(
      agent,
      model,
      options.projectRoot,
      mcp.clients,
      skills,
      commands,
      subagents,
      subagentDispatches,
      backgroundBash,
      gate,
      compactionManager,
      config.preserveRecentMessages,
      trajectory,
      diagnosticsLog,
      {
        config,
        permissionMode,
        sessionId: session.sessionId,
        resumed: session.restoreRequested && agent.messages.length > 0,
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
        workingContextProblem: workingContext.problem,
        promptCache,
        // Recomputed rather than returned from createModelFromConfig: the model
        // factory needs only the fields, while the header needs the reason a level
        // was clamped. Both come from the same pure planner, so they cannot disagree.
        thinking: thinkingPlan,
        mcpConfigPath: mcp.configPath,
        mcpConfigPaths: mcp.configPaths,
        mcpOverriddenServerNames: mcp.overriddenServerNames,
        permissionRulesPath: permissionRulesPath(options.projectRoot),
        hookSources: policy.hookSources,
        mcpIgnoredConfigPath: mcp.ignoredConfigPath,
        mcpServerCount: mcp.clients.length,
        toolNames: agent.tools.map((tool) => tool.name).sort(),
        trajectoryFile: trajectory?.status.file,
        diagnosticsFile: diagnosticsLog?.path,
      },
    );
    return runtime;
    };
    return assemble().catch(async (error: unknown) => {
      await AgentRuntime.unwindCreate(diagnosticsLog, startupMcpClients, startupBackgroundBash);
      throw error;
    });
  }

  /**
   * Runs one turn, yielding SDK stream events untouched so callers can render
   * whichever ones they care about.
   *
   * Snapshots the accumulated usage before the turn so `lastTurnUsage` can
   * report the delta — including cancelled turns, where the delta reflects
   * whatever model calls completed before the cancel.
   *
   * The trajectory recorder observes from between `stream()` and the `yield`, in
   * {@link recordStream} — a pass-through generator that records synchronously and
   * cannot throw, so it can neither reorder, delay nor swallow an event, and a
   * recording failure cannot become a second way for a turn to die. It lives in its
   * own module so the property can be measured over a real `Agent.stream()`
   * (`spike/verify-trajectory.ts`) rather than asserted about code only a live model
   * reaches.
   *
   * The turn's spend reaches the record through a meter handed to `beginTurn`, and not
   * from this `finally`, because of when the two run: `recordStream`'s `finally` closes
   * and buffers the `turnEnded` record *before* this one executes, so a number produced
   * here would always be one step too late for it. The meter is read while that record is
   * composed. Keeping the write there also keeps it off this error path, where a throw
   * would replace the provider's error object with the recorder's — the one thing the
   * observer contract forbids.
   *
   * One `before` snapshot feeds both the meter and `lastTurnDelta`, so what the record
   * says a turn cost and what `/usage` says it cost cannot be two different readings.
   */
  async *send(input: string): AsyncIterable<AgentStreamEvent> {
    const before = this.usage;
    try {
      // The append the recorder schedules at turn end is deliberately not awaited
      // here; `shutdown()` is where the chain is waited for.
      yield* recordStream(
        this.agent.stream(input),
        this.trajectory?.beginTurn(input, startTurnSpend(before, () => this.usage, this.liveConfig)),
      );
    } finally {
      this.lastTurnDelta = deltaUsage(before, this.usage);
    }
  }

  /**
   * What this run has recorded, or `undefined` when recording is switched off.
   *
   * Read rather than pushed: a trajectory problem is worth one notice after the
   * turn that hit it (where the context-pressure check already lives), not an
   * observer that could interrupt the frame mid-stream.
   */
  get trajectoryStatus(): TrajectoryStatus | undefined {
    return this.trajectory?.status;
  }

  /**
   * The diagnostics log, or `undefined` when nobody asked for one.
   *
   * Handed out rather than wrapped in per-entry methods so a caller can decide *once*
   * whether it is logging at all: the TUI swaps its whole dispatch function on this
   * being defined, which is what keeps a default run's notice path byte-for-byte what
   * it was. Everything on it is synchronous and non-throwing by contract.
   */
  get diagnostics(): DiagnosticsLog | undefined {
    return this.diagnosticsLog;
  }

  /**
   * What this run has logged, or `undefined` when the log is off. Read after a turn,
   * exactly like {@link trajectoryStatus} and for the same reason: a problem is worth
   * one notice where the context-pressure check already lives, never an observer that
   * interrupts the frame mid-stream.
   */
  get diagnosticsStatus(): DiagnosticsStatus | undefined {
    return this.diagnosticsLog?.status;
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
   * Estimates the context the next model request would carry, without sending
   * anything: the SDK's default `countTokens` is a character heuristic (darwin
   * never enables the native counting API), so this is free, offline, and safe
   * to call mid-turn — it reads messages and never mutates them. The window
   * comes from the SDK's own per-model table, `undefined` when unknown.
   */
  async contextEstimate(): Promise<ContextEstimate> {
    return {
      estimatedTokens: await countConversationTokens(this.model, this.agent),
      messageCount: this.agent.messages.length,
      windowTokens: this.model.getConfig().contextWindowLimit,
    };
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
   * `~/.darwin/config.json`.
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

    const thinkingPlan = planThinking(next);
    const promptCachePlan = planPromptCache(next);
    // Validate/cache-shape mutation before swapping the live model. A malformed
    // prompt must leave provider/config selection untouched, even when the target
    // provider needs no explicit cache point.
    if (!canUpdateSystemPromptCache(this.agent)) {
      throw new Error('Could not update the final cache point on the assembled system prompt.');
    }
    const cacheUpdated = applySystemPromptCachePoint(this.agent, promptCachePlan);
    if (promptCachePlan.parts.includes('system prompt') !== cacheUpdated) {
      throw new Error('Could not update the final cache point on the assembled system prompt.');
    }

    this.agent.model = model;
    this.model = model;
    this.liveConfig = next;
    this.subagents.updateConfig(next);
    this.thinkingPlan = thinkingPlan;
    this.promptCachePlan = promptCachePlan;

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
      // Absence and a measured zero are different provider statements. Preserve
      // that distinction for the provider-aware usage projection.
      ...(usage.cacheReadInputTokens !== undefined && {
        cacheReadInputTokens: usage.cacheReadInputTokens,
      }),
      ...(usage.cacheWriteInputTokens !== undefined && {
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
      }),
    };
  }

  /**
   * Token delta for the most recently completed turn, or `undefined` before any
   * turn has finished. A cancelled turn still produces a delta covering whatever
   * model calls completed before the cancel.
   */
  get lastTurnUsage(): UsageTotals | undefined {
    return this.lastTurnDelta;
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
   * Every subagent dispatch of this run, in start order, running and finished
   * alike. Synchronous — unlike {@link listBackgroundTasks}, which snapshots live
   * OS processes through per-task queues, this is an in-memory registry with no
   * I/O at all.
   *
   * These are *runs*, not the catalogue: `info.agentNames` lists the definitions
   * that may be dispatched, which is a different question answered by a different
   * path. Records carry name, task text, state and timestamps only — never any
   * part of a child's transcript.
   */
  listSubagentDispatches(): SubagentDispatchStatus[] {
    return this.subagentDispatches.list();
  }

  /** Publishes future terminal dispatch snapshots until the returned closure is called. */
  subscribeToSubagentDispatches(listener: SubagentDispatchListener): () => void {
    return this.subagentDispatches.subscribe(listener);
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
  async shutdown(options: { throwOnError?: boolean } = {}): Promise<void> {
    // Cleared before the awaits below: the log is about to be closed, and an SDK
    // warning logged during cleanup must not be handed to a sink that has stopped
    // accepting lines. `warn`/`error` keep reaching the renderer either way.
    if (this.diagnosticsLog !== undefined) setSdkVerboseSink(undefined);
    const results = await Promise.allSettled([
      this.subagents.shutdown(),
      this.backgroundBash.shutdown(),
      this.stopBashSession(options.throwOnError === true),
      disconnectAll(this.mcpClients, { throwOnError: options.throwOnError === true }),
      // The one place the append chain is awaited, so the last turn's records are
      // durable before the process exits. Settled alongside the rest: a record that
      // cannot be written must not skip process cleanup.
      this.trajectory?.close() ?? Promise.resolve(),
      // Same rule for the diagnostics log, and it cannot reject: its failures are
      // latched internally and reported as a problem, never thrown.
      this.diagnosticsLog?.close() ?? Promise.resolve(),
    ]);
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (options.throwOnError === true && failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} runtime cleanup operation(s) failed`);
    }
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
  private async stopBashSession(throwOnError = false): Promise<void> {
    const bashTool = this.agent.tool['bash'];
    if (bashTool === undefined) return;

    try {
      await bashTool.invoke({ mode: 'restart' }, { recordDirectToolCall: false });
    } catch (error) {
      // Interactive shutdown remains best-effort. Headless mode asks for the
      // failure after every cleanup operation has still had its chance to run.
      if (throwOnError) throw error;
    }
  }
}

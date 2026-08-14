/**
 * Agent assembly. The only place that constructs the SDK `Agent`.
 *
 * The runtime is deliberately thin: it wires SDK pieces together and hands the
 * raw event stream to whatever is driving it. Callers (the dev REPL now, Ink
 * later) decide how to render.
 */
import { Agent, SummarizingConversationManager } from '@strands-agents/sdk';
import type { AgentStreamEvent, McpClient } from '@strands-agents/sdk';
import { bash } from '@strands-agents/sdk/vended-tools/bash';
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor';

import { appendAllowRule, createModelFromConfig, loadConfig, type AppConfig } from '../config.js';
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
  private constructor(
    private readonly agent: Agent,
    private readonly projectRoot: string,
    private readonly mcpClients: readonly McpClient[],
    private readonly skills: SkillsPlugin,
    private readonly gate: PermissionGate,
    readonly info: RuntimeInfo,
  ) {}

  static async create(options: RuntimeOptions): Promise<AgentRuntime> {
    const config = await loadConfig(options.projectRoot);
    const model = await createModelFromConfig(config);
    const session = await resolveSession(options.projectRoot, options.resume);
    const skills = await SkillsPlugin.load(options.projectRoot);
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
      sessionManager: createSessionManager(options.projectRoot, session.sessionId),
      conversationManager: new SummarizingConversationManager({
        summaryRatio: config.summaryRatio,
        preserveRecentMessages: config.preserveRecentMessages,
      }),
      interventions: [gate],
      // Required: the SDK's own printer writes to stdout and would interleave
      // with our rendering (and fight Ink for the terminal in step 5).
      printer: false,
    });

    // The constructor does not initialize; the SDK defers it to the first
    // invocation. Session restore runs on InitializedEvent, MCP tools are
    // discovered here, and plugins inject their system prompt fragments — so
    // without this the resumed history and MCP tools would not exist yet.
    await agent.initialize();

    // Strictly after initialize(): the skills catalogue is appended during it, and
    // the cache point has to sit at the very end of the finished prompt (the skills
    // plugin also refuses to append to a block-array prompt). Tools and the
    // conversation are cached by the model's own cacheConfig, set in config.ts.
    const promptCache = planPromptCache(config);
    applySystemPromptCachePoint(agent, promptCache);

    return new AgentRuntime(agent, options.projectRoot, mcp.clients, skills, gate, {
      config,
      permissionMode,
      sessionId: session.sessionId,
      resumed: session.resumed,
      skillNames: skills.skills.map((skill) => skill.name),
      skillProblems: skills.problems.map((problem) => ({ ...problem })),
      projectInstructions:
        instructions === undefined
          ? undefined
          : { path: instructions.path, bytes: instructions.bytes, truncated: instructions.truncated },
      projectInstructionsProblem: loadedInstructions.problem,
      systemPromptSource: basePrompt.source,
      systemPromptPath: basePrompt.path,
      systemPromptProblem: basePrompt.problem,
      promptCache,
      mcpConfigPath: mcp.configPath,
      mcpIgnoredConfigPath: mcp.ignoredConfigPath,
      mcpServerCount: mcp.clients.length,
      toolNames: agent.tools.map((tool) => tool.name).sort(),
    });
  }

  /**
   * Runs one turn, yielding SDK stream events untouched so callers can render
   * whichever ones they care about.
   */
  async *send(input: string): AsyncIterable<AgentStreamEvent> {
    yield* this.agent.stream(input);
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

  /**
   * Asks the agent to stop the current turn at its next safe point. The stream
   * ends with `stopReason: 'cancelled'` rather than throwing.
   */
  cancel(): void {
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
   * Expands a `/skill-name` command into a message carrying the skill's full
   * text. Returns null when the input names no known skill, so callers can treat
   * it as ordinary input (or their own command, like `/exit`).
   */
  async expandSlashCommand(input: string): Promise<ExpandedSkillCommand | null> {
    return expandSkillCommand(this.skills, input);
  }

  /**
   * Releases every child process the session owns. Must run on exit: both the
   * bash shell and stdio MCP servers are spawned subprocesses whose open pipes
   * keep the event loop alive, so skipping this hangs the process instead of
   * exiting.
   */
  async shutdown(): Promise<void> {
    await Promise.allSettled([this.stopBashSession(), disconnectAll(this.mcpClients)]);
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

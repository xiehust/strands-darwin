/**
 * Configuration loading and model construction.
 *
 * Switching provider is a config-file change only — nothing else in the codebase
 * names a provider.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BedrockModel } from '@strands-agents/sdk';
import type { BaseModelConfig, JSONValue, Model } from '@strands-agents/sdk';

import { isValidRule } from './agent/permission-rules.js';
import { APPROVAL_MODES, type ApprovalMode } from './agent/permission.js';
import {
  bedrockCacheConfig,
  planPromptCache,
  PROMPT_CACHE_TTLS,
  type PromptCacheTtl,
} from './agent/prompt-cache.js';
import {
  claudeThinkingFields,
  DEFAULT_THINKING_EFFORT,
  isThinkingEffort,
  openaiThinkingParams,
  planThinking,
  THINKING_EFFORTS,
  type ThinkingEffort,
  type ThinkingPlan,
} from './agent/thinking.js';
import { darwinDir } from './paths.js';

/** Raised for malformed or unusable configuration. Always carries a fix hint. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const PROVIDERS = ['bedrock', 'anthropic', 'openai'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface AppConfig {
  provider: Provider;
  /**
   * Provider-specific model identifier. For Bedrock this must be a cross-region
   * inference profile (`us.` or `global.` prefix) — a bare `anthropic.*` id is
   * rejected by the service.
   */
  model: string;
  /** Bedrock only. Falls back to AWS_REGION, then AWS_DEFAULT_REGION, then us-west-2. */
  region?: string;
  /** Env var holding the API key, for providers that need one. */
  apiKeyEnv?: string;
  maxTokens: number;
  /** Fraction of oldest messages summarized on context overflow. */
  summaryRatio: number;
  /** Messages always kept verbatim by the summarizer. */
  preserveRecentMessages: number;
  /** When the permission gate asks for confirmation. See {@link ApprovalMode}. */
  permissionMode: ApprovalMode;
  /**
   * Wildcard rules that pre-approve tool calls, written here when the user answers
   * a confirmation prompt with "always allow". Absent when nothing has been
   * remembered. Format is documented in `src/agent/permission-rules.ts`.
   */
  permissionRules?: { readonly allow: readonly string[] };

  /**
   * Prompt caching, on by default. darwin re-sends a large unchanging prefix every
   * turn (tool schemas, the assembled system prompt, the conversation so far), so
   * the cache-write premium pays for itself almost immediately. Only Claude models
   * can cache; for anything else this is ignored — see `src/agent/prompt-cache.ts`.
   */
  promptCache: boolean;
  /**
   * Lifetime of every cache point. Optional; unset means the provider's own
   * default (5 minutes on Bedrock). `1h` costs more to write and suits long
   * sessions with gaps between turns.
   */
  promptCacheTtl?: PromptCacheTtl;
  /**
   * How hard the model thinks before answering: `low`, `medium`, `high` (the
   * default), `xhigh` or `max`. Claude serves this as *adaptive* thinking — the
   * model decides per request whether to think at all — so a low level is a hint
   * to skip it on easy work, not a hard budget. See `src/agent/thinking.ts`.
   *
   * A level the model cannot serve is clamped rather than sent, so raising this is
   * always safe. On the `openai` provider it becomes `reasoning_effort`, which
   * only reasoning models accept — a non-reasoning OpenAI model will reject every
   * request, so pair that provider with a reasoning model.
   */
  thinkingEffort: ThinkingEffort;
  /**
   * Model id for `auto` mode's safety classifier. Optional — each provider has
   * a cheap default. Bedrock ids must be inference profiles, like `model`.
   */
  classifierModel?: string;
  /**
   * Replaces darwin's built-in base system prompt. Optional; for prompts too long
   * to be comfortable in JSON, write `.darwin/system-prompt.md` instead (this
   * field wins over that file). AGENTS.md and the skills catalogue are appended
   * either way — see `src/agent/system-prompt.ts`.
   */
  systemPrompt?: string;
}

export const CONFIG_FILENAME = 'config.json';

/** `<projectRoot>/.darwin/config.json`. */
export function configPath(projectRoot: string): string {
  return path.join(darwinDir(projectRoot), CONFIG_FILENAME);
}

const DEFAULTS = {
  provider: 'bedrock',
  model: 'us.anthropic.claude-sonnet-4-6',
  maxTokens: 8192,
  summaryRatio: 0.3,
  preserveRecentMessages: 10,
  permissionMode: 'default',
  promptCache: true,
  thinkingEffort: DEFAULT_THINKING_EFFORT,
} as const satisfies Partial<AppConfig>;

const DEFAULT_REGION = 'us-west-2';

/** Bedrock rejects bare model ids; only cross-region inference profiles work. */
const BEDROCK_PROFILE_PREFIXES = ['us.', 'eu.', 'apac.', 'global.'];

export function resolveRegion(configured?: string): string {
  return (
    configured ??
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    DEFAULT_REGION
  );
}

/**
 * Loads `.darwin/config.json` from `projectRoot`. A missing file is normal — the
 * defaults are a working Bedrock setup. A present but malformed file is an
 * error, since silently ignoring it would hide the user's intent.
 */
export async function loadConfig(projectRoot: string): Promise<AppConfig> {
  const file = configPath(projectRoot);

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (isFileNotFound(error)) return { ...DEFAULTS };
    throw new ConfigError(`Could not read ${file}: ${describe(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${describe(error)}`);
  }

  return validate(parsed, file);
}

function validate(parsed: unknown, configPath: string): AppConfig {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${configPath} must contain a JSON object.`);
  }
  const input = parsed as Record<string, unknown>;

  const provider = input['provider'] ?? DEFAULTS.provider;
  if (!isProvider(provider)) {
    throw new ConfigError(
      `${configPath}: unknown provider ${JSON.stringify(provider)}. Expected one of ${PROVIDERS.join(', ')}.`,
    );
  }

  const permissionMode = input['permissionMode'] ?? DEFAULTS.permissionMode;
  if (!isApprovalMode(permissionMode)) {
    throw new ConfigError(
      `${configPath}: unknown permissionMode ${JSON.stringify(permissionMode)}. ` +
        `Expected one of ${APPROVAL_MODES.join(', ')}.`,
    );
  }

  // Rejected rather than clamped, unlike an unsupported-but-real level: a typo is
  // not intent, and silently thinking at some other depth than the file says is
  // both a cost and a quality surprise.
  const thinkingEffort = input['thinkingEffort'] ?? DEFAULTS.thinkingEffort;
  if (!isThinkingEffort(thinkingEffort)) {
    throw new ConfigError(
      `${configPath}: unknown thinkingEffort ${JSON.stringify(thinkingEffort)}. ` +
        `Expected one of ${THINKING_EFFORTS.join(', ')}.`,
    );
  }

  const config: AppConfig = {
    provider,
    permissionMode,
    thinkingEffort,
    model: stringField(input, 'model', configPath) ?? DEFAULTS.model,
    maxTokens: numberField(input, 'maxTokens', configPath, { min: 1 }) ?? DEFAULTS.maxTokens,
    summaryRatio:
      numberField(input, 'summaryRatio', configPath, { min: 0, max: 1 }) ?? DEFAULTS.summaryRatio,
    preserveRecentMessages:
      numberField(input, 'preserveRecentMessages', configPath, { min: 0 }) ??
      DEFAULTS.preserveRecentMessages,
    promptCache: booleanField(input, 'promptCache', configPath) ?? DEFAULTS.promptCache,
  };

  // Checked rather than passed through: an unsupported TTL is only rejected once
  // the first request reaches Bedrock, as an opaque ValidationException.
  const promptCacheTtl = input['promptCacheTtl'];
  if (promptCacheTtl !== undefined) {
    if (!isPromptCacheTtl(promptCacheTtl)) {
      throw new ConfigError(
        `${configPath}: unknown promptCacheTtl ${JSON.stringify(promptCacheTtl)}. ` +
          `Expected one of ${PROMPT_CACHE_TTLS.join(', ')}.`,
      );
    }
    config.promptCacheTtl = promptCacheTtl;
  }

  const permissionRules = input['permissionRules'];
  if (permissionRules !== undefined) {
    config.permissionRules = { allow: allowRulesField(permissionRules, configPath) };
  }

  const region = stringField(input, 'region', configPath);
  if (region !== undefined) config.region = region;

  const apiKeyEnv = stringField(input, 'apiKeyEnv', configPath);
  if (apiKeyEnv !== undefined) config.apiKeyEnv = apiKeyEnv;

  const classifierModel = stringField(input, 'classifierModel', configPath);
  if (classifierModel !== undefined) config.classifierModel = classifierModel;

  // Whitespace-only would pass the non-empty check and silently leave the agent
  // with no instructions at all, which nobody configures on purpose.
  const systemPrompt = stringField(input, 'systemPrompt', configPath);
  if (systemPrompt !== undefined) {
    if (systemPrompt.trim() === '') {
      throw new ConfigError(`${configPath}: "systemPrompt" must not be blank.`);
    }
    config.systemPrompt = systemPrompt;
  }

  return config;
}

/**
 * Validates `permissionRules`. A typo here is not harmless in either direction:
 * an unparseable rule would silently never match (the user believes they are no
 * longer being asked), so it is rejected like every other bad config value.
 */
function allowRulesField(value: unknown, configPath: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(
      `${configPath}: "permissionRules" must be an object, e.g. { "allow": ["bash:pnpm *"] }.`,
    );
  }

  const allow = (value as Record<string, unknown>)['allow'];
  if (allow === undefined) return [];
  if (!Array.isArray(allow)) {
    throw new ConfigError(`${configPath}: "permissionRules.allow" must be an array of rule strings.`);
  }

  for (const entry of allow) {
    if (typeof entry !== 'string' || !isValidRule(entry)) {
      throw new ConfigError(
        `${configPath}: ${JSON.stringify(entry)} is not a permission rule. ` +
          `Use "<tool>" for a whole tool or "<tool>:<pattern>" for a wildcard, ` +
          `e.g. "bash:pnpm *" or "fileEditor:src/**".`,
      );
    }
  }
  return [...(allow as string[])];
}

/**
 * Adds one rule to `permissionRules.allow` in `.darwin/config.json`, creating the
 * file when there is none.
 *
 * Merges into the raw JSON instead of serializing an {@link AppConfig}: writing
 * back a loaded config would freeze today's defaults into the user's file and
 * drop any key this version does not know about.
 */
export async function appendAllowRule(projectRoot: string, rule: string): Promise<void> {
  if (!isValidRule(rule)) {
    throw new ConfigError(`Refusing to save ${JSON.stringify(rule)}: it is not a permission rule.`);
  }

  const file = configPath(projectRoot);
  const record = await readConfigRecord(file);

  const existing = record['permissionRules'];
  const rules: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const allow = Array.isArray(rules['allow']) ? [...(rules['allow'] as unknown[])] : [];
  if (!allow.includes(rule)) allow.push(rule);

  rules['allow'] = allow;
  record['permissionRules'] = rules;

  await writeConfigRecord(file, record);
}

/**
 * Persists `thinkingEffort` in `.darwin/config.json`, so a level chosen with
 * `/effort` is still in effect next session.
 *
 * Merged into the raw JSON for the same reason as {@link appendAllowRule}: writing
 * back a loaded {@link AppConfig} would freeze today's defaults into the user's
 * file and drop any key this version does not know about. The caller has already
 * applied the level to the running model, so a failed write costs the memory of
 * the choice and nothing else — which is why this throws rather than swallowing.
 */
export async function saveThinkingEffort(projectRoot: string, effort: ThinkingEffort): Promise<void> {
  if (!isThinkingEffort(effort)) {
    throw new ConfigError(`Refusing to save ${JSON.stringify(effort)}: it is not a thinking effort level.`);
  }

  const file = configPath(projectRoot);
  const record = await readConfigRecord(file);
  record['thinkingEffort'] = effort;
  await writeConfigRecord(file, record);
}

/** Writes the config file back, creating `.darwin/` when this is the first write. */
async function writeConfigRecord(file: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** The config file as a plain object. A missing or empty file reads as `{}`. */
async function readConfigRecord(file: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (isFileNotFound(error)) return {};
    throw new ConfigError(`Could not read ${file}: ${describe(error)}`);
  }

  if (raw.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${describe(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${file} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Builds the SDK model for the configured provider.
 *
 * Anthropic and OpenAI live behind dynamic imports because their model modules
 * require peer dependencies (`@anthropic-ai/sdk`, `openai`) that a Bedrock-only
 * install does not have. A static import would break the default setup.
 */
export async function createModelFromConfig(config: AppConfig): Promise<Model> {
  switch (config.provider) {
    case 'bedrock':
      return createBedrockModel(config);
    case 'anthropic':
      return createAnthropicModel(config);
    case 'openai':
      return createOpenAIModel(config);
  }
}

function createBedrockModel(config: AppConfig): Model {
  if (!BEDROCK_PROFILE_PREFIXES.some((prefix) => config.model.startsWith(prefix))) {
    throw new ConfigError(
      `Bedrock model ${JSON.stringify(config.model)} is not a cross-region inference profile. ` +
        `Prefix it with one of ${BEDROCK_PROFILE_PREFIXES.join(', ')} ` +
        `(e.g. "us.anthropic.claude-sonnet-4-6"). List yours with: ` +
        `aws bedrock list-inference-profiles --region ${resolveRegion(config.region)}`,
    );
  }
  const cacheConfig = bedrockCacheConfig(planPromptCache(config));
  const thinking = claudeThinkingFields(planThinking(config));
  return new BedrockModel({
    region: resolveRegion(config.region),
    modelId: config.model,
    maxTokens: config.maxTokens,
    // Appends a cache point after the tool schemas and to the last user message on
    // every request. Omitted entirely when caching is off, since `strategy: 'auto'`
    // on a model that cannot cache makes the SDK warn straight to the console.
    ...(cacheConfig !== undefined && { cacheConfig }),
    // Adaptive thinking plus its effort level. The SDK drops the `thinking` key by
    // itself when a request forces tool use, which Bedrock refuses to combine with
    // thinking — so this is safe to set once for the whole session.
    ...(thinking !== undefined && { additionalRequestFields: thinking }),
  });
}

async function createAnthropicModel(config: AppConfig): Promise<Model> {
  // Config is validated before the import: a mistake in the user's own file is
  // reported whether or not the optional peer dependency happens to be installed.
  const apiKey = readApiKey(config);
  const { AnthropicModel } = await importProviderModule<typeof import('@strands-agents/sdk/models/anthropic')>(
    '@strands-agents/sdk/models/anthropic',
    'anthropic',
    '@anthropic-ai/sdk',
  );
  // `params` is merged into the request body verbatim, which is how the same two
  // adaptive-thinking fields reach the native API — it has no dedicated option.
  const thinking = claudeThinkingFields(planThinking(config));
  return new AnthropicModel({
    modelId: config.model,
    maxTokens: config.maxTokens,
    ...(apiKey !== undefined && { apiKey }),
    ...(thinking !== undefined && { params: thinking as Record<string, unknown> }),
  });
}

async function createOpenAIModel(config: AppConfig): Promise<Model> {
  const apiKey = readApiKey(config);
  const { OpenAIModel } = await importProviderModule<typeof import('@strands-agents/sdk/models/openai')>(
    '@strands-agents/sdk/models/openai',
    'openai',
    'openai',
  );
  const params = openaiThinkingParams(planThinking(config));
  return new OpenAIModel({
    api: 'chat',
    modelId: config.model,
    maxTokens: config.maxTokens,
    ...(apiKey !== undefined && { apiKey }),
    ...(params !== undefined && { params }),
  });
}

/**
 * Reconfigures a live model to think at `effort`, returning what it will actually
 * do (the level may be clamped — see `src/agent/thinking.ts`).
 *
 * Reconfiguration rather than reconstruction, because the point of `/effort` is to
 * change depth *without* losing the conversation: `Model.updateConfig()` merges
 * into the existing config, so the region, cache config and token budget the model
 * was built with all stay as they were.
 *
 * The provider switch lives here because this file is the only one that names a
 * provider; the fields themselves come from `src/agent/thinking.ts`.
 */
export function applyThinkingEffort(model: Model, config: AppConfig, effort: ThinkingEffort): ThinkingPlan {
  const plan = planThinking(config, effort);
  // Both keys are provider-specific extensions of BaseModelConfig, which is all
  // the abstract `Model` exposes; the cast is safe because the provider is known.
  const updatable = model as Model<ThinkingModelConfig>;

  switch (config.provider) {
    case 'bedrock':
      // Assigning undefined clears it: updateConfig spreads over the old config.
      updatable.updateConfig({ additionalRequestFields: claudeThinkingFields(plan) });
      break;
    case 'anthropic':
      updatable.updateConfig({ params: claudeThinkingFields(plan) as Record<string, unknown> | undefined });
      break;
    case 'openai':
      updatable.updateConfig({ params: openaiThinkingParams(plan) });
      break;
  }
  return plan;
}

/**
 * The provider-config fields {@link applyThinkingEffort} writes. Declared here
 * rather than imported: `AnthropicModelConfig` and `OpenAIModelConfig` live in
 * modules whose type declarations pull in the optional peer dependencies, so
 * importing them would break `tsc` on a Bedrock-only install.
 */
interface ThinkingModelConfig extends BaseModelConfig {
  /** Bedrock: merged into the Converse request body. */
  additionalRequestFields?: JSONValue | undefined;
  /** Anthropic / OpenAI: merged into the native request body. */
  params?: Record<string, unknown> | undefined;
}

/** Turns a missing peer dependency into an actionable install instruction. */
async function importProviderModule<T>(specifier: string, provider: Provider, peerDep: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (error) {
    throw new ConfigError(
      `Provider "${provider}" needs the ${peerDep} package, which is not installed. ` +
        `Run: pnpm add ${peerDep}\nUnderlying error: ${describe(error)}`,
    );
  }
}

/**
 * Reads the API key from the env var named by `apiKeyEnv`. Returning undefined
 * is fine — each provider SDK falls back to its own conventional env var.
 */
function readApiKey(config: AppConfig): string | undefined {
  if (config.apiKeyEnv === undefined) return undefined;
  const value = process.env[config.apiKeyEnv];
  if (value === undefined || value === '') {
    throw new ConfigError(
      `Config sets apiKeyEnv to ${JSON.stringify(config.apiKeyEnv)} but that environment variable is empty.`,
    );
  }
  return value;
}

function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value);
}

function isPromptCacheTtl(value: unknown): value is PromptCacheTtl {
  return typeof value === 'string' && (PROMPT_CACHE_TTLS as readonly string[]).includes(value);
}

function booleanField(
  input: Record<string, unknown>,
  key: string,
  configPath: string,
): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${configPath}: "${key}" must be true or false.`);
  }
  return value;
}

function stringField(input: Record<string, unknown>, key: string, configPath: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new ConfigError(`${configPath}: "${key}" must be a non-empty string.`);
  }
  return value;
}

/**
 * Range is checked here rather than left to the provider: an out-of-range value
 * either fails much later as an opaque service error (`maxTokens: 0`) or quietly
 * misbehaves (a `summaryRatio` above 1 summarizes more messages than exist).
 */
function numberField(
  input: Record<string, unknown>,
  key: string,
  configPath: string,
  range: { min: number; max?: number },
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`${configPath}: "${key}" must be a finite number.`);
  }
  if (value < range.min || (range.max !== undefined && value > range.max)) {
    const bounds = range.max === undefined ? `at least ${range.min}` : `between ${range.min} and ${range.max}`;
    throw new ConfigError(`${configPath}: "${key}" must be ${bounds}, got ${value}.`);
  }
  return value;
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

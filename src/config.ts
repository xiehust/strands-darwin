/**
 * Configuration loading and model construction.
 *
 * Switching provider is a config-file change only — nothing else in the codebase
 * names a provider.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';

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
import type { ToolHookCommand, ToolHookGroup, ToolHooksConfig } from './hooks/tool-hooks.js';
import { darwinDir, userDarwinDir, userProjectDir } from './paths.js';

/** Raised for malformed or unusable configuration. Always carries a fix hint. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const PROVIDERS = ['bedrock', 'anthropic', 'openai'] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * Which OpenAI API the `openai` provider speaks. Declared here rather than
 * imported from the SDK's `OpenAIApi`: that module's types pull in the optional
 * `openai` peer dependency, which a Bedrock-only install does not have.
 */
export const OPENAI_API_MODES = ['chat', 'responses'] as const;
export type OpenAIApiMode = (typeof OPENAI_API_MODES)[number];

export interface AppConfig extends ModelFields, SessionFields {
  /**
   * Every model this config offers, in file order, with the enabled one marked —
   * the catalogue `/model` switches between. Always at least one entry: the
   * single-model form describes itself as a lone enabled choice, so the runtime
   * never has to ask which form was used.
   *
   * Neither a model field nor a session field, but derived from the file as a
   * whole, which is why it sits on {@link AppConfig} rather than in either half.
   */
  modelChoices: readonly ModelChoice[];
}

/** One entry of the `models` array, validated and ready to build a model from. */
export interface ModelChoice {
  /** Position in the `models` array; 0 for the single-model form. */
  index: number;
  /** The entry's `name`, falling back to its model id. Used to address it. */
  name: string;
  /** Whether this is the entry in effect. Exactly one choice is enabled. */
  enabled: boolean;
  /** The entry's own model configuration, fully validated. */
  fields: ModelFields;
}

/**
 * The half of {@link AppConfig} that describes one model. In the array form this
 * is exactly what one `models` entry may set; see {@link MODEL_KEYS}.
 */
export interface ModelFields {
  provider: Provider;
  /**
   * Short label for this configuration, for `/model` and the header. Optional;
   * the model id is used when it is absent. Names are compared case-insensitively
   * and must be unique within the file.
   */
  name?: string;
  /**
   * Provider-specific model identifier. For Bedrock this must be a cross-region
   * inference profile (`us.` or `global.` prefix) — a bare `anthropic.*` id is
   * rejected by the service.
   */
  model: string;
  /**
   * Bedrock, and Bedrock Mantle. Falls back to AWS_REGION, then
   * AWS_DEFAULT_REGION, then us-west-2.
   */
  region?: string;
  /** Env var holding the API key, for providers that need one. */
  apiKeyEnv?: string;
  /**
   * `openai` provider only: route requests through Amazon Bedrock's
   * OpenAI-compatible "Mantle" endpoint instead of `api.openai.com`, reaching
   * `openai.*` / `xai.*` / `google.gemma-*` models with AWS credentials rather
   * than an API key. The SDK derives the base URL from {@link region} and the
   * model id, and mints a bearer token per request from the standard AWS
   * credential chain — so {@link apiKeyEnv} must not be set alongside it.
   *
   * The model catalog is per-region and does not match Bedrock's own: list it
   * with `pnpm tsx spike/probe-mantle-catalog.ts <region>`.
   */
  bedrockMantle?: boolean;
  /**
   * `openai` provider only: which OpenAI API to speak. `chat` (the default) is
   * Chat Completions; `responses` is the Responses API, which the newest models
   * require — `openai.gpt-5.6-*` on Mantle rejects `/v1/chat/completions`
   * outright. Chosen rather than inferred because the two coexist in one
   * catalog: `openai.gpt-oss-*` is Chat Completions, `openai.gpt-5.6-*` is not.
   *
   * Only the stateless form of `responses` is used: darwin always installs a
   * conversation manager, which the SDK forbids combining with server-managed
   * state.
   */
  openaiApi?: OpenAIApiMode;
  maxTokens: number;
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
   * always safe. On the `openai` provider it becomes a reasoning effort, which
   * only reasoning models accept — a non-reasoning OpenAI model will reject every
   * request, so pair that provider with a reasoning model.
   *
   * Model-scoped on purpose: the levels one model accepts are not the levels
   * another does, so `/effort` persists into the enabled `models` entry.
   */
  thinkingEffort: ThinkingEffort;
  /**
   * Model id for `auto` mode's safety classifier. Optional — each provider has
   * a cheap default. Bedrock ids must be inference profiles, like `model`.
   */
  classifierModel?: string;
}

/**
 * The half of {@link AppConfig} that outlives a model switch. These always live
 * at the config root, never inside a `models` entry; see {@link SESSION_KEYS}.
 */
export interface SessionFields {
  /** Fraction of oldest messages summarized on context overflow. */
  summaryRatio: number;
  /** Messages always kept verbatim by the summarizer. */
  preserveRecentMessages: number;
  /** When the permission gate asks for confirmation. See {@link ApprovalMode}. */
  permissionMode: ApprovalMode;
  /** Deprecated policy fields retained on the type for migration fixtures only. */
  permissionRules?: { readonly allow: readonly string[] };
  hooks?: ToolHooksConfig;

  /**
   * Replaces darwin's built-in base system prompt. Optional; for prompts too long
   * to be comfortable in JSON, write `.darwin/system-prompt.md` instead (this
   * field wins over that file). AGENTS.md and the skills catalogue are appended
   * either way — see `src/agent/system-prompt.ts`.
   */
  systemPrompt?: string;
}

export const CONFIG_FILENAME = 'config.json';

/**
 * Keys that describe *which model to talk to and how*. In the array form these
 * may only appear inside a `models` entry; at the root they are the single-model
 * form. Listed rather than inferred because the two forms are validated by the
 * same function and the error messages name the key that is in the wrong place.
 */
const MODEL_KEYS = [
  'provider',
  'name',
  'model',
  'region',
  'apiKeyEnv',
  'bedrockMantle',
  'openaiApi',
  'maxTokens',
  'thinkingEffort',
  'promptCache',
  'promptCacheTtl',
  'classifierModel',
] as const;

/**
 * Keys that describe *the session*, not the model: they outlive a model switch
 * and so always live at the root, never in a `models` entry. A permission mode
 * that silently applied to one model and not another would be a security
 * surprise, which is why an entry carrying one is rejected rather than ignored.
 */
const SESSION_KEYS = [
  'permissionMode',
  'hooks',
  'summaryRatio',
  'preserveRecentMessages',
  'systemPrompt',
] as const;

/** `~/.darwin/config.json`. The optional argument remains for source compatibility. */
export function configPath(_projectRoot?: string): string {
  const file = path.join(userDarwinDir(), CONFIG_FILENAME);
  // Callers historically wrote fixtures directly to this returned path.
  // Ensuring the parent synchronously keeps that API usable after the move home.
  mkdirSync(path.dirname(file), { recursive: true });
  return file;
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
 * Completes a flat config with the one-entry catalogue it implies.
 *
 * The single-model form and a hand-built config both describe exactly one choice,
 * and deriving it here rather than writing it out keeps the catalogue from ever
 * disagreeing with the fields beside it.
 */
export function withSoleChoice<T extends ModelFields & SessionFields>(config: T): T & AppConfig {
  return {
    ...config,
    modelChoices: [{ index: 0, name: config.name ?? config.model, enabled: true, fields: config }],
  };
}

/**
 * Rebuilds a config around a different {@link ModelChoice}, keeping the session.
 *
 * Built from the session keys up rather than spread over the old config: spreading
 * would leave the *previous* model's optional fields behind — a switch away from a
 * Mantle entry would keep its `region` and `openaiApi`, silently configuring the
 * new model with the old one's transport. That is the same leak the loader is
 * tested against, so it must not reappear at switch time.
 *
 * The session half is copied through {@link SESSION_KEYS} so this function and the
 * validator cannot disagree about which keys survive a model change.
 */
export function withModelChoice(config: AppConfig, target: ModelChoice): AppConfig {
  const session: Record<string, unknown> = {};
  for (const key of SESSION_KEYS) {
    if (config[key] !== undefined) session[key] = config[key];
  }

  return {
    // Safe: SESSION_KEYS are exactly the keys of SessionFields, and the required
    // ones are always present on a validated AppConfig.
    ...(session as unknown as SessionFields),
    ...target.fields,
    modelChoices: config.modelChoices.map((choice) => ({ ...choice, enabled: choice.index === target.index })),
  };
}

/**
 * Loads `~/.darwin/config.json` from `projectRoot`. A missing file is normal — the
 * defaults are a working Bedrock setup. A present but malformed file is an
 * error, since silently ignoring it would hide the user's intent.
 */
export async function loadConfig(projectRoot: string): Promise<AppConfig> {
  const file = configPath(projectRoot);

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (isFileNotFound(error)) return withSoleChoice({ ...DEFAULTS });
    throw new ConfigError(`Could not read ${file}: ${describe(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${describe(error)}`);
  }

  // Checked here rather than in validate(): rules live in a project-keyed file
  // under ~/.darwin/projects/, so only the caller's projectRoot can name the
  // destination — and "move them somewhere" is not an instruction a user can act on.
  if (isRecord(parsed) && parsed['permissionRules'] !== undefined) {
    throw new ConfigError(
      `${file}: "permissionRules" are project-scoped and are never read from the global config. ` +
        `Move them to ${permissionRulesPath(projectRoot)}.`,
    );
  }

  return validate(parsed, file);
}

function validate(parsed: unknown, configPath: string): AppConfig {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${configPath} must contain a JSON object.`);
  }
  const input = parsed as Record<string, unknown>;
  const session = validateSessionFields(input, configPath);

  // The array form is a *file* format, not a second runtime shape: the enabled
  // entry is resolved here and the result is the same flat AppConfig the
  // single-model form produces, so nothing downstream knows which form was used.
  if (input['models'] === undefined) {
    return withSoleChoice({ ...validateModelFields(input, configPath), ...session });
  }

  const choices = validateModelChoices(input, configPath);
  const enabled = choices.find((choice) => choice.enabled) as ModelChoice;
  return { ...enabled.fields, ...session, modelChoices: choices };
}

/**
 * Validates every entry of a `models` array and marks the enabled one.
 *
 * *Every* entry, not just the enabled one: `/model` switches to a disabled entry
 * without re-reading the file, so a typo in one would otherwise surface as a
 * broken switch mid-session instead of a refusal to start.
 */
function validateModelChoices(input: Record<string, unknown>, configPath: string): ModelChoice[] {
  const entries = modelEntries(input, configPath);
  const enabledIndex = selectEnabledIndex(entries, configPath);

  const choices = entries.map((entry, index) => {
    const fields = validateModelFields(entry, `${configPath} models[${index}]`);
    return { index, name: fields.name ?? fields.model, enabled: index === enabledIndex, fields };
  });

  // Names address entries in `/model`, so a duplicate would make one of them
  // unreachable — refused rather than silently resolved to the first match.
  const seen = new Map<string, number>();
  for (const choice of choices) {
    const key = choice.name.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      throw new ConfigError(
        `${configPath}: models[${first}] and models[${choice.index}] are both called ` +
          `${JSON.stringify(choice.name)}. Give one of them a distinct "name".`,
      );
    }
    seen.set(key, choice.index);
  }

  return choices;
}

/**
 * Reads and structurally checks the `models` array: every entry an object, in the
 * right half of the file, with a boolean `enable`. No field validation here —
 * that is {@link validateModelFields}, so both file forms share it.
 */
function modelEntries(root: Record<string, unknown>, configPath: string): Record<string, unknown>[] {
  const models = root['models'];
  if (!Array.isArray(models)) {
    throw new ConfigError(
      `${configPath}: "models" must be an array of model configurations, ` +
        `e.g. [{ "enable": true, "provider": "bedrock", "model": "us.anthropic.claude-sonnet-4-6" }].`,
    );
  }
  if (models.length === 0) {
    throw new ConfigError(`${configPath}: "models" is empty — list at least one model configuration.`);
  }

  // Rejected rather than merged: with entries present there is no sensible
  // precedence between a root-level model key and an entry's, and inventing one
  // would mean the file no longer says which model is in effect.
  const strays = MODEL_KEYS.filter((key) => root[key] !== undefined);
  if (strays.length > 0) {
    throw new ConfigError(
      `${configPath}: ${strays.map((key) => JSON.stringify(key)).join(', ')} ` +
        `${strays.length === 1 ? 'belongs' : 'belong'} inside a "models" entry, not next to "models". ` +
        `Move ${strays.length === 1 ? 'it' : 'them'} into the entry you want ${strays.length === 1 ? 'it' : 'them'} to apply to.`,
    );
  }

  return models.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`${configPath}: models[${index}] must be a JSON object.`);
    }
    const record = entry as Record<string, unknown>;

    const misplaced = SESSION_KEYS.filter((key) => record[key] !== undefined);
    if (misplaced.length > 0) {
      throw new ConfigError(
        `${configPath}: models[${index}] carries ${misplaced.map((key) => JSON.stringify(key)).join(', ')}, ` +
          `which ${misplaced.length === 1 ? 'applies' : 'apply'} to the whole session, not to one model. ` +
          `Move ${misplaced.length === 1 ? 'it' : 'them'} to the top level.`,
      );
    }

    const enable = record['enable'];
    if (enable !== undefined && typeof enable !== 'boolean') {
      throw new ConfigError(`${configPath}: models[${index}]: "enable" must be true or false.`);
    }
    return record;
  });
}

/**
 * Finds the position of the one enabled entry.
 *
 * Exactly one, never "the first one that is enabled": a config with two models
 * switched on is a mistake with a price attached, and quietly picking one would
 * bill the user for a model they did not think they were using. Zero enabled is
 * refused for the same reason — falling back to the built-in default would run a
 * model the file does not even mention.
 */
function selectEnabledIndex(entries: readonly Record<string, unknown>[], configPath: string): number {
  const enabled = entries.filter((entry) => entry['enable'] === true);

  if (enabled.length === 0) {
    throw new ConfigError(
      `${configPath}: no model is enabled — set "enable": true on exactly one of the ` +
        `${entries.length} entries in "models" (${entries.map(labelOf).join(', ')}).`,
    );
  }
  if (enabled.length > 1) {
    throw new ConfigError(
      `${configPath}: ${enabled.length} models are enabled (${enabled.map(labelOf).join(', ')}). ` +
        `Exactly one entry may have "enable": true.`,
    );
  }

  return entries.indexOf(enabled[0] as Record<string, unknown>);
}

/** How an entry is named in an error message: its model id, else its position. */
function labelOf(entry: Record<string, unknown>): string {
  const model = entry['model'];
  return typeof model === 'string' && model !== '' ? JSON.stringify(model) : '<no "model">';
}

/**
 * Validates the model-scoped keys of `input`, which is either the config root
 * (single-model form) or one `models` entry. Shared deliberately: the two forms
 * must accept exactly the same fields, or the array form would quietly be a
 * second, weaker dialect.
 */
function validateModelFields(input: Record<string, unknown>, where: string): ModelFields {
  const provider = input['provider'] ?? DEFAULTS.provider;
  if (!isProvider(provider)) {
    throw new ConfigError(
      `${where}: unknown provider ${JSON.stringify(provider)}. Expected one of ${PROVIDERS.join(', ')}.`,
    );
  }

  // Rejected rather than clamped, unlike an unsupported-but-real level: a typo is
  // not intent, and silently thinking at some other depth than the file says is
  // both a cost and a quality surprise.
  const thinkingEffort = input['thinkingEffort'] ?? DEFAULTS.thinkingEffort;
  if (!isThinkingEffort(thinkingEffort)) {
    throw new ConfigError(
      `${where}: unknown thinkingEffort ${JSON.stringify(thinkingEffort)}. ` +
        `Expected one of ${THINKING_EFFORTS.join(', ')}.`,
    );
  }

  const fields: ModelFields = {
    provider,
    thinkingEffort,
    model: stringField(input, 'model', where) ?? DEFAULTS.model,
    maxTokens: numberField(input, 'maxTokens', where, { min: 1 }) ?? DEFAULTS.maxTokens,
    promptCache: booleanField(input, 'promptCache', where) ?? DEFAULTS.promptCache,
  };

  // Checked rather than passed through: an unsupported TTL is only rejected once
  // the first request reaches Bedrock, as an opaque ValidationException.
  const promptCacheTtl = input['promptCacheTtl'];
  if (promptCacheTtl !== undefined) {
    if (!isPromptCacheTtl(promptCacheTtl)) {
      throw new ConfigError(
        `${where}: unknown promptCacheTtl ${JSON.stringify(promptCacheTtl)}. ` +
          `Expected one of ${PROMPT_CACHE_TTLS.join(', ')}.`,
      );
    }
    fields.promptCacheTtl = promptCacheTtl;
  }

  const region = stringField(input, 'region', where);
  if (region !== undefined) fields.region = region;

  const name = stringField(input, 'name', where);
  if (name !== undefined) fields.name = name;

  const apiKeyEnv = stringField(input, 'apiKeyEnv', where);
  if (apiKeyEnv !== undefined) fields.apiKeyEnv = apiKeyEnv;

  // Rejected here rather than left to the SDK, which throws the same conflict as
  // a bare Error naming neither the file nor the two keys the user wrote.
  const bedrockMantle = booleanField(input, 'bedrockMantle', where);
  if (bedrockMantle !== undefined) {
    if (bedrockMantle && provider !== 'openai') {
      throw new ConfigError(
        `${where}: "bedrockMantle" only applies to provider "openai" (this one sets ${JSON.stringify(provider)}). ` +
          `Bedrock's own models are reached with provider "bedrock".`,
      );
    }
    if (bedrockMantle && apiKeyEnv !== undefined) {
      throw new ConfigError(
        `${where}: "bedrockMantle" and "apiKeyEnv" are mutually exclusive — ` +
          `Mantle mints its own bearer token from AWS credentials. Remove "apiKeyEnv".`,
      );
    }
    fields.bedrockMantle = bedrockMantle;
  }

  const openaiApi = input['openaiApi'];
  if (openaiApi !== undefined) {
    if (!isOpenAIApiMode(openaiApi)) {
      throw new ConfigError(
        `${where}: unknown openaiApi ${JSON.stringify(openaiApi)}. ` +
          `Expected one of ${OPENAI_API_MODES.join(', ')}.`,
      );
    }
    if (provider !== 'openai') {
      throw new ConfigError(
        `${where}: "openaiApi" only applies to provider "openai" (this one sets ${JSON.stringify(provider)}).`,
      );
    }
    fields.openaiApi = openaiApi;
  }

  const classifierModel = stringField(input, 'classifierModel', where);
  if (classifierModel !== undefined) fields.classifierModel = classifierModel;

  return fields;
}

/** Validates the keys that belong to the session rather than to a model. */
function validateSessionFields(input: Record<string, unknown>, configPath: string): SessionFields {
  const permissionMode = input['permissionMode'] ?? DEFAULTS.permissionMode;
  if (!isApprovalMode(permissionMode)) {
    throw new ConfigError(
      `${configPath}: unknown permissionMode ${JSON.stringify(permissionMode)}. ` +
        `Expected one of ${APPROVAL_MODES.join(', ')}.`,
    );
  }

  const fields: SessionFields = {
    permissionMode,
    summaryRatio:
      numberField(input, 'summaryRatio', configPath, { min: 0, max: 1 }) ?? DEFAULTS.summaryRatio,
    preserveRecentMessages:
      numberField(input, 'preserveRecentMessages', configPath, { min: 0 }) ??
      DEFAULTS.preserveRecentMessages,
  };

  // Retained as a deprecated global fallback for ~/.darwin/hooks.json. Runtime
  // policy loading owns execution; carrying it here preserves /model semantics.
  const hooks = input['hooks'];
  if (hooks !== undefined) fields.hooks = hooksField(hooks, configPath);

  // Whitespace-only would pass the non-empty check and silently leave the agent
  // with no instructions at all, which nobody configures on purpose.
  const systemPrompt = stringField(input, 'systemPrompt', configPath);
  if (systemPrompt !== undefined) {
    if (systemPrompt.trim() === '') {
      throw new ConfigError(`${configPath}: "systemPrompt" must not be blank.`);
    }
    fields.systemPrompt = systemPrompt;
  }

  return fields;
}

function hooksField(value: unknown, configPath: string): ToolHooksConfig {
  const where = `${configPath}: "hooks"`;
  if (!isRecord(value)) throw new ConfigError(`${where} must be an object.`);

  for (const key of Object.keys(value)) {
    if (key !== 'PreToolUse' && key !== 'PostToolUse') {
      throw new ConfigError(`${where}.${key} is not supported. Expected PreToolUse or PostToolUse.`);
    }
  }

  const result: { PreToolUse?: ToolHookGroup[]; PostToolUse?: ToolHookGroup[] } = {};
  for (const event of ['PreToolUse', 'PostToolUse'] as const) {
    const groups = value[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) {
      throw new ConfigError(`${where}.${event} must be an array of matcher groups.`);
    }
    result[event] = groups.map((group, index) =>
      hookGroupField(group, `${where}.${event}[${index}]`),
    );
  }
  return result;
}

function hookGroupField(value: unknown, where: string): ToolHookGroup {
  if (!isRecord(value)) throw new ConfigError(`${where} must be an object.`);

  const matcher = value['matcher'];
  if (typeof matcher !== 'string' || matcher.trim() === '') {
    throw new ConfigError(`${where}.matcher must be a nonblank string.`);
  }

  const hooks = value['hooks'];
  if (!Array.isArray(hooks) || hooks.length === 0) {
    throw new ConfigError(`${where}.hooks must be a nonempty array of command hooks.`);
  }

  return {
    matcher,
    hooks: hooks.map((hook, index) => hookCommandField(hook, `${where}.hooks[${index}]`)),
  };
}

function hookCommandField(value: unknown, where: string): ToolHookCommand {
  if (!isRecord(value)) throw new ConfigError(`${where} must be an object.`);
  if (value['type'] !== 'command') {
    throw new ConfigError(`${where}.type must be "command".`);
  }
  const command = value['command'];
  if (typeof command !== 'string' || command.trim() === '') {
    throw new ConfigError(`${where}.command must be a nonblank string.`);
  }
  return { type: 'command', command };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export const PERMISSION_RULES_FILENAME = 'permission-rules.json';
export const HOOKS_FILENAME = 'hooks.json';

export function permissionRulesPath(projectRoot: string): string {
  return path.join(userProjectDir(projectRoot), PERMISSION_RULES_FILENAME);
}

export function globalHooksPath(): string {
  return path.join(userDarwinDir(), HOOKS_FILENAME);
}

export function projectHooksPath(projectRoot: string): string {
  return path.join(darwinDir(projectRoot), HOOKS_FILENAME);
}

export interface ProjectPolicy {
  allowRules: string[];
  hooks: ToolHooksConfig | undefined;
  hookSources: string[];
  legacyRules: boolean;
}

/** Loads project-scoped rules and layered global/project hooks. */
export async function loadProjectPolicy(projectRoot: string): Promise<ProjectPolicy> {
  const primaryRules = permissionRulesPath(projectRoot);
  const legacyProject = path.join(darwinDir(projectRoot), CONFIG_FILENAME);
  const globalConfig = configPath();
  const globalHooks = globalHooksPath();
  const projectHooks = projectHooksPath(projectRoot);

  const primaryRecord = await readOptionalRecord(primaryRules);
  const legacyRecord = primaryRecord === undefined ? await readOptionalRecord(legacyProject) : undefined;
  const allowRules = primaryRecord === undefined
    ? legacyRecord?.['permissionRules'] === undefined
      ? []
      : allowRulesField(legacyRecord['permissionRules'], legacyProject)
    : allowRulesField(primaryRecord, primaryRules);

  const globalPrimary = await readOptionalRecord(globalHooks);
  const globalLegacy = globalPrimary === undefined ? await readOptionalRecord(globalConfig) : undefined;
  const projectPrimary = await readOptionalRecord(projectHooks);
  const projectLegacy = projectPrimary === undefined
    ? (legacyRecord ?? await readOptionalRecord(legacyProject))
    : undefined;
  const globalLayer = globalPrimary === undefined
    ? hooksFromRecord(globalLegacy, globalConfig)
    : hooksField(globalPrimary, globalHooks);
  const projectLayer = projectPrimary === undefined
    ? hooksFromRecord(projectLegacy, legacyProject)
    : hooksField(projectPrimary, projectHooks);
  const hooks = mergeHooks(globalLayer, projectLayer);
  return {
    allowRules,
    hooks,
    hookSources: [
      globalPrimary !== undefined ? globalHooks : globalLayer === undefined ? undefined : globalConfig,
      projectPrimary !== undefined ? projectHooks : projectLayer === undefined ? undefined : legacyProject,
    ].filter((source): source is string => source !== undefined),
    legacyRules: primaryRecord === undefined && legacyRecord?.['permissionRules'] !== undefined,
  };
}

/** Adds one project-scoped allow rule, promoting legacy rules on first write. */
export async function appendAllowRule(projectRoot: string, rule: string): Promise<void> {
  if (!isValidRule(rule)) {
    throw new ConfigError(`Refusing to save ${JSON.stringify(rule)}: it is not a permission rule.`);
  }
  const policy = await loadProjectPolicy(projectRoot);
  const allow = [...policy.allowRules];
  if (!allow.includes(rule)) allow.push(rule);
  await writeConfigRecord(permissionRulesPath(projectRoot), { allow });
}

function hooksFromRecord(record: Record<string, unknown> | undefined, file: string): ToolHooksConfig | undefined {
  return record?.['hooks'] === undefined ? undefined : hooksField(record['hooks'], file);
}

function mergeHooks(globalHooks: ToolHooksConfig | undefined, projectHooks: ToolHooksConfig | undefined): ToolHooksConfig | undefined {
  if (globalHooks === undefined && projectHooks === undefined) return undefined;
  return {
    PreToolUse: [...(globalHooks?.PreToolUse ?? []), ...(projectHooks?.PreToolUse ?? [])],
    PostToolUse: [...(projectHooks?.PostToolUse ?? []), ...(globalHooks?.PostToolUse ?? [])],
  };
}

async function readOptionalRecord(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(parsed)) throw new Error('top-level value must be an object');
    return parsed;
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw new ConfigError(`${file} could not be loaded: ${describe(error)}`);
  }
}

/**
 * Persists `thinkingEffort` in `~/.darwin/config.json`, so a level chosen with
 * `/effort` is still in effect next session.
 *
 * In the array form the level is written into the *enabled* entry, not the root:
 * `thinkingEffort` is model-scoped, and a root-level copy would be rejected on
 * the next load as a stray model key — turning a convenience into a config that
 * refuses to start.
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
  // Reuses the loader's own selection so the level cannot land on a different
  // entry than the session is running: one rule for "which model is enabled".
  const entries = record['models'] === undefined ? undefined : modelEntries(record, file);
  const target = entries === undefined ? record : entries[selectEnabledIndex(entries, file)];
  (target as Record<string, unknown>)['thinkingEffort'] = effort;
  await writeConfigRecord(file, record);
}

/**
 * Moves `enable: true` to the entry at `index`, switching every other entry off,
 * so a `/model` change is still in effect next session.
 *
 * Writes `false` explicitly rather than deleting the key: an entry that visibly
 * says `"enable": false` is the switch this format is built around, and a file
 * where the off entries simply lack the key reads as if they were never
 * considered.
 *
 * Raw-JSON merge and throw-don't-swallow for the same reasons as
 * {@link saveThinkingEffort}: the caller has already switched the live model, so a
 * failed write costs only the memory of the choice.
 */
export async function saveEnabledModel(projectRoot: string, index: number): Promise<void> {
  const file = configPath(projectRoot);
  const record = await readConfigRecord(file);

  if (record['models'] === undefined) {
    throw new ConfigError(
      `${file} configures a single model, so there is nothing to switch between. ` +
        `Move it into a "models" array to keep more than one configuration.`,
    );
  }

  const entries = modelEntries(record, file);
  const target = entries[index];
  if (target === undefined) {
    throw new ConfigError(`${file}: there is no models[${index}] to enable (${entries.length} entries).`);
  }

  for (const entry of entries) entry['enable'] = entry === target;
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
  const { OpenAIModel } = await importProviderModule<typeof import('@strands-agents/sdk/models/openai')>(
    '@strands-agents/sdk/models/openai',
    'openai',
    'openai',
  );
  const api = openaiApiMode(config);
  const params = openaiThinkingParams(planThinking(config), api);

  // Mantle derives both the base URL and the credential, so it replaces the API
  // key rather than joining it — the SDK rejects being given both. The region is
  // resolved here rather than left to the SDK's own env lookup so a run cannot
  // use a different region than the rest of darwin reports: the Mantle catalog is
  // per-region (`openai.gpt-5.6-sol` is us-east-1 only) and a wrong region shows
  // up as a 404 naming the model, never the region.
  const client =
    config.bedrockMantle === true
      ? { bedrockMantleConfig: { region: resolveRegion(config.region) } }
      : optionalApiKey(readApiKey(config));

  const options = {
    modelId: config.model,
    maxTokens: config.maxTokens,
    ...client,
    ...(params !== undefined && { params }),
  };

  // Branched on the literal rather than passing `api` through: `OpenAIModelOptions`
  // is discriminated on it, and a union-typed `api` would widen the options to the
  // point where a chat-only field on a responses config no longer fails to compile.
  return api === 'responses' ? new OpenAIModel({ api: 'responses', ...options }) : new OpenAIModel({ api: 'chat', ...options });
}

/** Which OpenAI API this config speaks. Chat Completions unless asked otherwise. */
function openaiApiMode(config: AppConfig): OpenAIApiMode {
  return config.openaiApi ?? 'chat';
}

/** The `apiKey` option, or nothing — each provider SDK has its own env fallback. */
function optionalApiKey(apiKey: string | undefined): { apiKey?: string } {
  return apiKey === undefined ? {} : { apiKey };
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
      updatable.updateConfig({ params: openaiThinkingParams(plan, openaiApiMode(config)) });
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

function isOpenAIApiMode(value: unknown): value is OpenAIApiMode {
  return typeof value === 'string' && (OPENAI_API_MODES as readonly string[]).includes(value);
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

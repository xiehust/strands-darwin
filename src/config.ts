/**
 * Configuration loading and model construction.
 *
 * Switching provider is a config-file change only — nothing else in the codebase
 * names a provider.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { BedrockModel } from '@strands-agents/sdk';
import type { Model } from '@strands-agents/sdk';

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

  const config: AppConfig = {
    provider,
    model: stringField(input, 'model', configPath) ?? DEFAULTS.model,
    maxTokens: numberField(input, 'maxTokens', configPath, { min: 1 }) ?? DEFAULTS.maxTokens,
    summaryRatio:
      numberField(input, 'summaryRatio', configPath, { min: 0, max: 1 }) ?? DEFAULTS.summaryRatio,
    preserveRecentMessages:
      numberField(input, 'preserveRecentMessages', configPath, { min: 0 }) ??
      DEFAULTS.preserveRecentMessages,
  };

  const region = stringField(input, 'region', configPath);
  if (region !== undefined) config.region = region;

  const apiKeyEnv = stringField(input, 'apiKeyEnv', configPath);
  if (apiKeyEnv !== undefined) config.apiKeyEnv = apiKeyEnv;

  return config;
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
  return new BedrockModel({
    region: resolveRegion(config.region),
    modelId: config.model,
    maxTokens: config.maxTokens,
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
  return new AnthropicModel({
    modelId: config.model,
    maxTokens: config.maxTokens,
    ...(apiKey !== undefined && { apiKey }),
  });
}

async function createOpenAIModel(config: AppConfig): Promise<Model> {
  const apiKey = readApiKey(config);
  const { OpenAIModel } = await importProviderModule<typeof import('@strands-agents/sdk/models/openai')>(
    '@strands-agents/sdk/models/openai',
    'openai',
    'openai',
  );
  return new OpenAIModel({
    api: 'chat',
    modelId: config.model,
    maxTokens: config.maxTokens,
    ...(apiKey !== undefined && { apiKey }),
  });
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

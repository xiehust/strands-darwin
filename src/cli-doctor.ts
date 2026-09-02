/**
 * `darwin doctor` — an offline, read-only diagnostics report.
 *
 * Composed from the loaders startup already uses (`loadConfig`, `loadSystemPrompt`,
 * `loadProjectInstructions`, `readMcpServerConfigs`, `scanSkills`, `loadProjectPolicy`,
 * the sessions-store readers) so the report says what a session *would* load, not
 * what a second parser thinks. The one rule that differs from startup: a loader
 * that would refuse to start here becomes a marked problem line instead — the
 * report always completes, and its exit code says whether anything was wrong.
 *
 * Zero mutation, by construction: no model call, no MCP process, no network, and no
 * file, directory or pointer created or moved anywhere — including `~/.darwin` and
 * the project's `.darwin/`. Every loader called from here is a pure reader
 * (`loadConfig` / `loadProjectPolicy` derive the config path through
 * `configFilePath()`, which unlike `configPath()` creates nothing; MCP servers are
 * read through `readMcpServerConfigs`, the declarative half of the loader that
 * never reaches the SDK's `loadServers`). The `sessions` precedent applies for the
 * rest: readers only, `spike/verify-doctor-command.ts` proves HOME and the project
 * byte-identical before and after.
 *
 * Exit codes follow the `sessions` / `trajectory` convention: 0 when no problem was
 * found, 1 when at least one was, 2 for a usage error.
 */
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { McpServerConfig } from '@strands-agents/sdk';

import { AGENTS_FILENAME, loadProjectInstructions, MAX_INSTRUCTIONS_BYTES } from './agent/instructions.js';
import { planPromptCache } from './agent/prompt-cache.js';
import { listSessionIds, readLastSessionId, sessionPaths } from './agent/session.js';
import { loadSystemPrompt } from './agent/system-prompt.js';
import { planThinking } from './agent/thinking.js';
import { CliUsageError } from './cli-args.js';
import {
  ConfigError,
  configFilePath,
  loadConfig,
  loadProjectPolicy,
  permissionRulesPath,
  resolveAnthropicBaseUrl,
  resolveRegion,
  type AppConfig,
  type ProjectPolicy,
} from './config.js';
import { mcpConfigCandidates, readMcpServerConfigs } from './mcp/registry.js';
import { extensionRoots } from './paths.js';
import { BUILTIN_SKILLS_DIR, REQUIRED_BUILTIN_SKILLS, scanSkills, SKILLS_DIRNAME } from './skills/loader.js';
import { DARWIN_VERSION } from './version.js';

export const DOCTOR_COMMAND = 'doctor';

export const DOCTOR_USAGE = `Usage: darwin ${DOCTOR_COMMAND}

  Prints a read-only diagnostics report for this project: config, system prompt,
  project instructions, MCP config, skills, hooks and policy, permission rules,
  sessions store and versions. Starts no session, calls no model, spawns and
  connects nothing, writes nothing. Exit 0 when no problem was found, 1 otherwise.`;

/** Marker every problem line starts with; the total at the end counts these. */
export const PROBLEM_MARKER = '! ';

/** Longest report line, in code points; longer lines end in `…`. */
export const MAX_DOCTOR_LINE_CHARS = 400;

/** Most entries one list (servers, skipped skills, hook files) prints before `… N more`. */
export const MAX_DOCTOR_LIST = 40;

/** True when argv asks for this subcommand at all, so `cli.ts` can route before anything else. */
export function isDoctorInvocation(argv: readonly string[]): boolean {
  return argv[0] === DOCTOR_COMMAND;
}

/** Parses argv *after* the `doctor` token. No I/O. */
export function parseDoctorArgs(argv: readonly string[]): void {
  if (argv.length > 0) {
    throw new CliUsageError(`${DOCTOR_COMMAND} takes no arguments.\n${DOCTOR_USAGE}`);
  }
}

export interface DoctorIo {
  projectRoot: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Accumulates the report; problems are counted as they are written. */
class Report {
  private readonly lines: string[] = [];
  problems = 0;

  section(title: string): void {
    if (this.lines.length > 0) this.lines.push('');
    this.lines.push(title);
  }

  info(text: string): void {
    this.lines.push(`  ${boundLine(text)}`);
  }

  problem(text: string): void {
    this.problems += 1;
    this.lines.push(`  ${PROBLEM_MARKER}${boundLine(text)}`);
  }

  /** Prints at most {@link MAX_DOCTOR_LIST} entries; the rest is one `… N more` row, problems still counted. */
  list(entries: readonly { text: string; problem: boolean }[]): void {
    const shown = entries.slice(0, MAX_DOCTOR_LIST);
    for (const entry of shown) {
      if (entry.problem) this.problem(entry.text);
      else this.info(entry.text);
    }
    const hidden = entries.slice(MAX_DOCTOR_LIST);
    if (hidden.length > 0) {
      const hiddenProblems = hidden.filter((entry) => entry.problem).length;
      this.problems += hiddenProblems;
      this.info(`… ${hidden.length} more${hiddenProblems > 0 ? ` (${hiddenProblems} of them problems, counted)` : ''}`);
    }
  }

  render(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

/** Runs the report and returns the process exit code. Never throws for a loader failure. */
export async function runDoctorCommand(io: DoctorIo): Promise<number> {
  const report = new Report();
  const projectRoot = path.resolve(io.projectRoot);
  report.section(`darwin doctor — read-only diagnostics for ${projectRoot}`);

  const config = await reportConfig(report, projectRoot);
  await reportSystemPrompt(report, projectRoot, config);
  await reportInstructions(report, projectRoot);
  await reportMcp(report, projectRoot);
  await reportSkills(report, projectRoot);
  const policy = await reportHooks(report, projectRoot);
  reportPermissionRules(report, projectRoot, policy);
  await reportSessions(report, projectRoot);
  reportVersions(report);

  report.section(
    report.problems === 0
      ? 'no problems found'
      : `${report.problems} problem${report.problems === 1 ? '' : 's'} found (lines marked ${PROBLEM_MARKER.trim()})`,
  );
  io.out(report.render());
  return report.problems === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

async function reportConfig(report: Report, projectRoot: string): Promise<AppConfig | undefined> {
  const file = configFilePath();
  report.section('config');
  const present = existsSync(file);
  report.info(present ? `file ${file}` : `file ${file} — absent, built-in defaults apply`);

  let config: AppConfig;
  try {
    // `loadConfig` reads through `configFilePath()`: nothing is created when
    // `~/.darwin` does not exist. A ConfigError is this report's job, not a crash.
    config = await loadConfig(projectRoot);
  } catch (error) {
    report.problem(`config: ${error instanceof ConfigError ? error.message : `unexpected failure: ${describe(error)}`}`);
    return undefined;
  }

  const label = config.name === undefined ? '' : ` (${config.name})`;
  report.info(`provider ${config.provider}   model ${config.model}${label}`);
  if (config.modelChoices.length > 1) {
    report.info(`models configured: ${config.modelChoices.length} (/model switches between them)`);
  }
  switch (config.provider) {
    case 'bedrock':
      report.info(`region ${resolveRegion(config.region)}`);
      break;
    case 'anthropic': {
      const baseUrl = resolveAnthropicBaseUrl(config);
      report.info(`base URL ${baseUrl ?? '(client default: https://api.anthropic.com)'}`);
      break;
    }
    case 'openai':
      if (config.bedrockMantle === true) report.info(`bedrock mantle on   region ${resolveRegion(config.region)}`);
      if (config.openaiApi !== undefined) report.info(`openai api ${config.openaiApi}`);
      break;
  }
  if (config.apiKeyEnv !== undefined) {
    // Never the value: only whether the named variable is set.
    const value = process.env[config.apiKeyEnv];
    report.info(`api key env ${config.apiKeyEnv}: ${value === undefined || value === '' ? 'not set' : 'set'}`);
  }

  const thinking = planThinking(config);
  report.info(
    `effort ${thinking.requested}` +
      (thinking.effective === thinking.requested ? '' : ` (effective ${thinking.effective ?? 'none'})`),
  );
  if (thinking.problem !== undefined) report.info(`note: ${thinking.problem}`);

  const cache = planPromptCache(config);
  report.info(
    `prompt cache ${cache.enabled || cache.automatic ? 'on' : 'off'}` +
      (cache.ttl === undefined ? '' : `   ttl ${cache.ttl}`),
  );
  if (cache.problem !== undefined) report.info(`note: ${cache.problem}`);

  report.info(
    `context offload ${config.contextOffload ? 'on' : 'off'}` +
      (config.maxResultTokens === undefined ? '' : `   maxResultTokens ${config.maxResultTokens}`),
  );
  // The same effective readings the runtime applies (`trajectory !== false`,
  // `diagnostics === true`, `memory === true`).
  report.info(
    `trajectory ${config.trajectory === false ? 'off' : 'on'}   ` +
      `memory ${config.memory === true ? 'on' : 'off'}   ` +
      `diagnostics ${config.diagnostics === true ? 'on' : 'off'}`,
  );
  report.info(`permission mode ${config.permissionMode}`);
  return config;
}

async function reportSystemPrompt(report: Report, projectRoot: string, config: AppConfig | undefined): Promise<void> {
  report.section('system prompt');
  const load = await loadSystemPrompt(projectRoot, config?.systemPrompt);
  switch (load.source) {
    case 'default':
      report.info('source built-in default');
      break;
    case 'config':
      report.info('source config systemPrompt');
      break;
    case 'file':
      report.info(`source file ${load.path ?? ''}`);
      break;
  }
  if (load.problem !== undefined) report.problem(`system prompt override skipped: ${load.problem}`);
}

async function reportInstructions(report: Report, projectRoot: string): Promise<void> {
  report.section('project instructions');
  const load = await loadProjectInstructions(projectRoot);
  if (load.problem !== undefined) {
    report.problem(`${AGENTS_FILENAME} could not be used: ${load.problem}`);
    return;
  }
  if (load.instructions === undefined) {
    report.info(`${path.join(projectRoot, AGENTS_FILENAME)} — absent or empty (nothing preloaded)`);
    return;
  }
  const { path: file, bytes, truncated } = load.instructions;
  report.info(`${file}   ${bytes.toLocaleString('en-US')} bytes (cap ${MAX_INSTRUCTIONS_BYTES.toLocaleString('en-US')})`);
  if (truncated) {
    report.problem(
      `${AGENTS_FILENAME} is over the cap: only the first ${MAX_INSTRUCTIONS_BYTES.toLocaleString('en-US')} bytes are preloaded, ` +
        `${(bytes - MAX_INSTRUCTIONS_BYTES).toLocaleString('en-US')} bytes are invisible to the agent`,
    );
  }
}

async function reportMcp(report: Report, projectRoot: string): Promise<void> {
  report.section('mcp');
  const candidates = mcpConfigCandidates(projectRoot);
  let configs;
  try {
    // The declarative half only: nothing is spawned, nothing connects.
    configs = await readMcpServerConfigs(projectRoot);
  } catch (error) {
    report.problem(`mcp: ${error instanceof ConfigError ? error.message.split('\n')[0] : describe(error)}`);
    return;
  }
  const used = new Set(configs.configPaths);
  for (const [role, file] of [
    ['global', candidates.global],
    ['project', candidates.preferred],
    ['project fallback', candidates.fallback],
  ] as const) {
    const state = used.has(file)
      ? 'read'
      : file === configs.ignoredConfigPath
        ? 'ignored (.darwin/mcp.json takes precedence)'
        : existsSync(file) ? 'present, not read' : 'absent';
    report.info(`${role} ${file} — ${state}`);
  }
  if (configs.overriddenServerNames.length > 0) {
    report.info(`overridden by the project layer: ${configs.overriddenServerNames.join(', ')}`);
  }
  if (configs.servers === undefined) {
    report.info('no MCP servers configured');
    return;
  }
  const names = Object.keys(configs.servers);
  report.info(`${names.length} server${names.length === 1 ? '' : 's'} configured`);
  report.list(names.map((name) => describeServer(name, configs.servers?.[name])));
}

function describeServer(name: string, server: McpServerConfig | undefined): { text: string; problem: boolean } {
  if (server === undefined || typeof server !== 'object') {
    return { text: `server ${name}: entry is not an object`, problem: true };
  }
  if (server.disabled === true) return { text: `server ${name}: disabled`, problem: false };
  const url = server.url;
  const command = server.command;
  if (typeof url === 'string' && (server.transport === undefined || server.transport !== 'stdio')) {
    return { text: `server ${name}: ${server.transport ?? 'streamable-http'} ${url} — not connected (doctor never connects)`, problem: false };
  }
  if (typeof command !== 'string' || command === '') {
    return { text: `server ${name}: neither "command" nor "url" is set`, problem: true };
  }
  if (command.includes('${')) {
    return { text: `server ${name}: stdio ${command} — not checked (interpolated at connect time)`, problem: false };
  }
  const found = lookupOnPath(command);
  return found === undefined
    ? { text: `server ${name}: stdio command "${command}" not found on PATH`, problem: true }
    : { text: `server ${name}: stdio command "${command}" found at ${found}`, problem: false };
}

/**
 * A plain PATH lookup — `X_OK` on each candidate, never a spawn. A command with a
 * path separator is checked where it points (relative to the current directory,
 * as a shell would); a bare name is searched along `PATH`. Answers the first
 * executable match, or `undefined`.
 */
export function lookupOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = command.includes('/') || (process.platform === 'win32' && command.includes('\\'))
    ? [path.resolve(command)]
    : (env['PATH'] ?? '').split(path.delimiter).filter((dir) => dir !== '').map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here, or not executable: keep looking.
    }
  }
  return undefined;
}

async function reportSkills(report: Report, projectRoot: string): Promise<void> {
  report.section('skills');
  let scan;
  try {
    scan = await scanSkills(projectRoot);
  } catch (error) {
    report.problem(`skills: ${describe(error)}`);
    return;
  }
  const layers: { label: string; directory: string }[] = [
    { label: 'built-in', directory: BUILTIN_SKILLS_DIR },
    ...extensionRoots(projectRoot).map((layer) => ({
      label: `${layer.scope} ${path.basename(layer.root)}`,
      directory: path.join(layer.root, SKILLS_DIRNAME),
    })),
  ];
  for (const layer of layers) {
    const count = scan.skills.filter((skill) => skill.path !== undefined && isInside(layer.directory, skill.path)).length;
    const state = existsSync(layer.directory) ? `${count} skill${count === 1 ? '' : 's'}` : 'absent';
    report.info(`${layer.label} ${layer.directory} — ${state}`);
  }
  // `scanSkills` throws when a required built-in is missing or broken, so reaching
  // this line means every one of them loaded.
  report.info(`required built-ins present: ${REQUIRED_BUILTIN_SKILLS.join(', ')}`);
  report.list(scan.problems.map((problem) => ({ text: `skill skipped ${problem.directory}: ${problem.reason}`, problem: true })));
}

async function reportHooks(report: Report, projectRoot: string): Promise<ProjectPolicy | undefined> {
  report.section('hooks and policy');
  let policy: ProjectPolicy;
  try {
    policy = await loadProjectPolicy(projectRoot);
  } catch (error) {
    report.problem(`hooks/policy: ${error instanceof ConfigError ? error.message : describe(error)}`);
    return undefined;
  }
  if (policy.toolHookLayers.length === 0) {
    report.info('no hook files (native hooks/*.json or portable .agents/hooks.json)');
  } else {
    report.list(policy.toolHookLayers.map((layer) => ({
      text: `${layer.file} — ${layer.dialect === 'codex' ? 'Codex adapter dialect' : 'native dialect'}`,
      problem: false,
    })));
  }
  for (const notice of policy.hookShadowNotices) {
    report.info(`shadowed in ${notice.layer} (${notice.directory} is authoritative): ${notice.shadowed.join(', ')}`);
  }
  return policy;
}

function reportPermissionRules(report: Report, projectRoot: string, policy: ProjectPolicy | undefined): void {
  report.section('permission rules');
  const file = permissionRulesPath(projectRoot);
  const present = existsSync(file);
  if (policy === undefined) {
    report.info(`${file} — ${present ? 'present' : 'absent'}, count unavailable (see the hooks/policy problem)`);
    return;
  }
  const count = policy.allowRules.length;
  const rules = `${count} allow rule${count === 1 ? '' : 's'}`;
  if (policy.legacyRules) {
    report.info(`${file} — absent; ${rules} read from the legacy project .darwin/config.json "permissionRules"`);
    return;
  }
  report.info(present ? `${file} — ${rules}` : `${file} — absent (${rules})`);
}

async function reportSessions(report: Report, projectRoot: string): Promise<void> {
  report.section('sessions');
  const paths = sessionPaths(projectRoot);
  if (!existsSync(paths.sessionsDir)) {
    report.info(`${paths.sessionsDir} — absent (no sessions yet)`);
    return;
  }
  // Both readers: a directory listing and a pointer read, never a pointer write.
  const ids = await listSessionIds(projectRoot);
  const last = await readLastSessionId(projectRoot);
  report.info(`${paths.sessionsDir} — ${ids.length} session${ids.length === 1 ? '' : 's'}`);
  report.info(last === undefined ? 'resume pointer: none' : `resume pointer: ${last}`);
}

function reportVersions(report: Report): void {
  report.section('versions');
  report.info(`darwin ${DARWIN_VERSION}`);
  report.info(`node ${process.version}`);
  report.info(`platform ${os.platform()} ${os.release()} (${os.arch()})`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function boundLine(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  const points = [...flat];
  return points.length > MAX_DOCTOR_LINE_CHARS ? `${points.slice(0, MAX_DOCTOR_LINE_CHARS - 1).join('')}…` : flat;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

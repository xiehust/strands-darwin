import { APPROVAL_MODES, type ApprovalMode } from './agent/permission.js';
import { isValidSessionId, type SessionSelector } from './agent/session.js';

/** A command-line shape the user must correct before darwin can start. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export const HEADLESS_OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const;
export type HeadlessOutputFormat = (typeof HEADLESS_OUTPUT_FORMATS)[number];

export interface CliOptions {
  /** Present only for one-shot/headless mode. */
  prompt: string | undefined;
  /** `text` preserves the original stdout/stderr protocol and is always the default. */
  outputFormat: HeadlessOutputFormat;
  /** Optional per-process ceiling enforced before each SDK model call. */
  maxModelCalls: number | undefined;
  /** Process-only context-offload opt-in; never persisted to config. */
  contextOffloadOverride: true | undefined;
  /** Summarize restored history before the requested one-shot turn. */
  compactBefore: boolean;
  /**
   * Which conversation to open. `--session <id>` is accepted in both modes: an id
   * is alphabet-validated here and `resolveSession` refuses one with no persisted
   * snapshot, so the old "headless only" restriction guarded nothing — and a forked
   * session, whose id exists only on stdout, would otherwise be impossible to open
   * in the TUI. `--continue` remains headless-only; `--resume` is its TUI spelling,
   * and `--resume <id>` names a specific session to reopen (ids come from
   * `darwin sessions`) — equivalent to `--session <id>`, so combining the two forms
   * is a usage error.
   */
  session: SessionSelector;
  permissionModeOverride: ApprovalMode | undefined;
}

/** Parses argv after the executable/script names. No I/O or runtime construction. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  let prompt: string | undefined;
  let sessionId: string | undefined;
  let resumeIdSeen = false;
  let permissionMode: ApprovalMode | undefined;
  let permissionModeSeen = false;
  let outputFormat: HeadlessOutputFormat = 'text';
  let outputFormatSeen = false;
  let maxModelCalls: number | undefined;
  let maxModelCallsSeen = false;
  let contextOffloadOverride: true | undefined;
  let contextOffloadSeen = false;
  let compactBefore = false;
  let compactBeforeSeen = false;
  let continueRequested = false;
  let resumeRequested = false;
  let yolo = argv.includes('--yolo');

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '-p':
      case '--print': {
        if (prompt !== undefined) throw new CliUsageError('-p/--print may be specified only once.');
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('-') || value.trim() === '') {
          throw new CliUsageError(`${flag} expects a non-empty message.`);
        }
        prompt = value;
        index += 1;
        break;
      }
      case '--output-format': {
        if (outputFormatSeen) throw new CliUsageError('--output-format may be specified only once.');
        outputFormatSeen = true;
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('-')) {
          throw new CliUsageError(
            `--output-format expects one of ${HEADLESS_OUTPUT_FORMATS.join(', ')}, got ${JSON.stringify('(nothing)')}.`,
          );
        }
        if (!(HEADLESS_OUTPUT_FORMATS as readonly string[]).includes(value)) {
          throw new CliUsageError(
            `--output-format expects one of ${HEADLESS_OUTPUT_FORMATS.join(', ')}, got ${JSON.stringify(value)}.`,
          );
        }
        outputFormat = value as HeadlessOutputFormat;
        index += 1;
        break;
      }
      case '--max-model-calls': {
        if (maxModelCallsSeen) throw new CliUsageError('--max-model-calls may be specified only once.');
        maxModelCallsSeen = true;
        const value = argv[index + 1];
        if (value === undefined || !/^[1-9]\d*$/u.test(value)) {
          throw new CliUsageError(
            `--max-model-calls expects a positive integer, got ${JSON.stringify(value ?? '(nothing)')}.`,
          );
        }
        maxModelCalls = Number(value);
        if (!Number.isSafeInteger(maxModelCalls)) {
          throw new CliUsageError(`--max-model-calls is too large: ${JSON.stringify(value)}.`);
        }
        index += 1;
        break;
      }
      case '--context-offload':
        if (contextOffloadSeen) throw new CliUsageError('--context-offload may be specified only once.');
        contextOffloadSeen = true;
        contextOffloadOverride = true;
        break;
      case '--compact-before':
        if (compactBeforeSeen) throw new CliUsageError('--compact-before may be specified only once.');
        compactBeforeSeen = true;
        compactBefore = true;
        break;
      case '--session': {
        if (resumeIdSeen) {
          throw new CliUsageError('--resume <id> and --session may not both name a session.');
        }
        if (sessionId !== undefined) throw new CliUsageError('--session may be specified only once.');
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('-') || value === '') {
          throw new CliUsageError('--session expects an id.');
        }
        if (!isValidSessionId(value)) {
          throw new CliUsageError(
            `Invalid session id ${JSON.stringify(value)}; use lowercase letters, numbers, hyphens, and underscores.`,
          );
        }
        sessionId = value;
        index += 1;
        break;
      }
      case '--permission-mode': {
        if (permissionModeSeen) throw new CliUsageError('--permission-mode may be specified only once.');
        permissionModeSeen = true;
        const value = argv[index + 1];
        if (value === undefined) {
          throw new CliUsageError(
            `--permission-mode expects one of ${APPROVAL_MODES.join(', ')}, got ${JSON.stringify('(nothing)')}.`,
          );
        }
        if (value === '--yolo') {
          index += 1;
          break;
        }
        if (value.startsWith('--')) {
          throw new CliUsageError(
            `--permission-mode expects one of ${APPROVAL_MODES.join(', ')}, got ${JSON.stringify('(nothing)')}.`,
          );
        }
        // Preserve the original CLI contract: --yolo wins even when the
        // redundant value flag is invalid, regardless of argument order.
        if (!(APPROVAL_MODES as readonly string[]).includes(value) && !argv.includes('--yolo')) {
          throw new CliUsageError(
            `--permission-mode expects one of ${APPROVAL_MODES.join(', ')}, got ${JSON.stringify(value)}.`,
          );
        }
        if ((APPROVAL_MODES as readonly string[]).includes(value)) permissionMode = value as ApprovalMode;
        index += 1;
        break;
      }
      case '--continue':
        continueRequested = true;
        break;
      case '--resume': {
        resumeRequested = true;
        // `--resume <id>` names the session to reopen; bare `--resume` (end of argv,
        // or followed by another flag) keeps its original pointer-following meaning.
        // A leading `-` is what separates "flag" from "id" here — the session-id
        // alphabet has no `-` prefix, so nothing valid is ever mistaken for a flag.
        const value = argv[index + 1];
        if (value !== undefined && !value.startsWith('-') && value !== '') {
          if (resumeIdSeen) throw new CliUsageError('--resume <id> may be specified only once.');
          if (sessionId !== undefined) {
            throw new CliUsageError('--resume <id> and --session may not both name a session.');
          }
          if (!isValidSessionId(value)) {
            throw new CliUsageError(
              `Invalid session id ${JSON.stringify(value)}; use lowercase letters, numbers, hyphens, and underscores.`,
            );
          }
          sessionId = value;
          resumeIdSeen = true;
          index += 1;
        }
        break;
      }
      case '--yolo':
        yolo = true;
        break;
      default:
        throw new CliUsageError(`Unknown argument ${JSON.stringify(flag)}.`);
    }
  }

  if (prompt === undefined && continueRequested) {
    throw new CliUsageError('--continue is available only with -p/--print; use --resume for the TUI.');
  }
  if (prompt === undefined && outputFormatSeen) {
    throw new CliUsageError('--output-format is available only with -p/--print.');
  }
  if (prompt === undefined && maxModelCallsSeen) {
    throw new CliUsageError('--max-model-calls is available only with -p/--print.');
  }
  if (prompt === undefined && contextOffloadSeen) {
    throw new CliUsageError('--context-offload is available only with -p/--print.');
  }
  if (prompt === undefined && compactBeforeSeen) {
    throw new CliUsageError('--compact-before is available only with -p/--print.');
  }

  const session: SessionSelector = sessionId !== undefined
    ? { kind: 'id', sessionId }
    : continueRequested || resumeRequested
      ? { kind: 'continue' }
      : { kind: 'new' };

  return {
    prompt,
    outputFormat,
    maxModelCalls,
    contextOffloadOverride,
    compactBefore,
    session,
    // Preserve the existing shorthand contract: --yolo wins over the value flag.
    permissionModeOverride: yolo ? 'yolo' : permissionMode,
  };
}

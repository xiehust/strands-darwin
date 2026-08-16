import { APPROVAL_MODES, type ApprovalMode } from './agent/permission.js';
import { isValidSessionId, type SessionSelector } from './agent/session.js';

/** A command-line shape the user must correct before darwin can start. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export interface CliOptions {
  /** Present only for one-shot/headless mode. */
  prompt: string | undefined;
  /**
   * Which conversation to open. `--session <id>` is accepted in both modes: an id
   * is alphabet-validated here and `resolveSession` refuses one with no persisted
   * snapshot, so the old "headless only" restriction guarded nothing — and a forked
   * session, whose id exists only on stdout, would otherwise be impossible to open
   * in the TUI. `--continue` remains headless-only; `--resume` is its TUI spelling.
   */
  session: SessionSelector;
  permissionModeOverride: ApprovalMode | undefined;
}

/** Parses argv after the executable/script names. No I/O or runtime construction. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  let prompt: string | undefined;
  let sessionId: string | undefined;
  let permissionMode: ApprovalMode | undefined;
  let permissionModeSeen = false;
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
      case '--session': {
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
      case '--resume':
        resumeRequested = true;
        break;
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

  const session: SessionSelector = sessionId !== undefined
    ? { kind: 'id', sessionId }
    : continueRequested || resumeRequested
      ? { kind: 'continue' }
      : { kind: 'new' };

  return {
    prompt,
    session,
    // Preserve the existing shorthand contract: --yolo wins over the value flag.
    permissionModeOverride: yolo ? 'yolo' : permissionMode,
  };
}

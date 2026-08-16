/**
 * `darwin trajectory <verb>` — reading the append-only record.
 *
 * Deliberately a separate parser from {@link parseCliArgs} rather than another
 * branch inside it: an agent run and a record inspection have nothing in common
 * except the executable name, and `CliOptions` describes exactly one of them.
 * Keeping them apart also keeps this path free of any model, agent or Ink import,
 * which is what makes "replay never calls a model" a structural property instead of
 * a promise.
 *
 * Exit codes follow the headless convention: 0 for a completed operation
 * (including a search that legitimately found nothing), 1 when a named session or
 * record is missing or unreadable, 2 for a usage error.
 */
import { hasSnapshot, listSessionIds, trajectoryPath } from './agent/session.js';
import { CliUsageError } from './cli-args.js';
import { isValidSessionId } from './agent/session.js';
import { forkSession } from './trajectory/fork.js';
import { readTrajectory, TrajectoryMissingError, describeDamage } from './trajectory/reader.js';
import { formatReplay, replayRead } from './trajectory/replay.js';
import { searchTrajectories, UnknownSessionError } from './trajectory/search.js';

/** Must match `AGENT_ID` in `src/agent/runtime.ts`: snapshots are keyed by it. */
const AGENT_ID = 'darwin';

export const TRAJECTORY_COMMAND = 'trajectory';

export const TRAJECTORY_USAGE = `Usage: darwin ${TRAJECTORY_COMMAND} <command>

  list                              recorded sessions in this project, newest first
  search <text> [--session <id>] [--type <t>] [--limit <n>]
                                    case-insensitive substring search over records
  replay <id> [--turn <n>] [--json] rebuild a recorded session's history; no model calls
  fork <id>                         copy a session into a new one, leaving the source untouched`;

export type TrajectoryCommand =
  | { verb: 'list' }
  | { verb: 'search'; query: string; sessionId?: string; type?: string; limit?: number }
  | { verb: 'replay'; sessionId: string; turn?: number; json: boolean }
  | { verb: 'fork'; sessionId: string };

/** True when argv asks for this subcommand at all, so `cli.ts` can route before anything else. */
export function isTrajectoryInvocation(argv: readonly string[]): boolean {
  return argv[0] === TRAJECTORY_COMMAND;
}

/** Parses argv *after* the `trajectory` token. No I/O. */
export function parseTrajectoryArgs(argv: readonly string[]): TrajectoryCommand {
  const verb = argv[0];
  const rest = argv.slice(1);

  switch (verb) {
    case 'list': {
      if (rest.length > 0) throw new CliUsageError(`${TRAJECTORY_COMMAND} list takes no arguments.`);
      return { verb: 'list' };
    }

    case 'search': {
      const query = rest[0];
      if (query === undefined || query.startsWith('--') || query.trim() === '') {
        throw new CliUsageError(`${TRAJECTORY_COMMAND} search expects a non-empty search text.`);
      }
      const flags = parseFlags(rest.slice(1), ['session', 'type', 'limit']);
      const command: TrajectoryCommand = { verb: 'search', query };
      if (flags.session !== undefined) command.sessionId = requireSessionId(flags.session);
      if (flags.type !== undefined) command.type = flags.type;
      if (flags.limit !== undefined) command.limit = requireCount(flags.limit, '--limit');
      return command;
    }

    case 'replay': {
      const sessionId = requireSessionId(rest[0]);
      const flags = parseFlags(rest.slice(1), ['turn'], ['json']);
      const command: TrajectoryCommand = { verb: 'replay', sessionId, json: flags.json === '' };
      if (flags.turn !== undefined) command.turn = requireCount(flags.turn, '--turn');
      return command;
    }

    case 'fork': {
      const sessionId = requireSessionId(rest[0]);
      if (rest.length > 1) throw new CliUsageError(`${TRAJECTORY_COMMAND} fork takes one session id.`);
      return { verb: 'fork', sessionId };
    }

    default:
      throw new CliUsageError(
        verb === undefined
          ? `${TRAJECTORY_COMMAND} expects a command.\n${TRAJECTORY_USAGE}`
          : `Unknown ${TRAJECTORY_COMMAND} command ${JSON.stringify(verb)}.\n${TRAJECTORY_USAGE}`,
      );
  }
}

function requireSessionId(value: string | undefined): string {
  if (value === undefined || value.startsWith('--') || value === '') {
    throw new CliUsageError(`${TRAJECTORY_COMMAND} expects a session id.`);
  }
  if (!isValidSessionId(value)) {
    throw new CliUsageError(
      `Invalid session id ${JSON.stringify(value)}; use lowercase letters, numbers, hyphens, and underscores.`,
    );
  }
  return value;
}

function requireCount(value: string, flag: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new CliUsageError(`${flag} expects a positive whole number, got ${JSON.stringify(value)}.`);
  }
  return Number(value);
}

/**
 * Minimal `--name value` / `--name` parser over one verb's remaining arguments.
 *
 * A boolean flag records the empty string, so presence is `!== undefined` for both
 * kinds and an unknown flag is a usage error rather than being silently ignored —
 * a mistyped `--sesion` must not turn into a project-wide scan.
 */
function parseFlags(
  argv: readonly string[],
  valued: readonly string[],
  booleans: readonly string[] = [],
): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) throw new CliUsageError(`Unexpected argument ${JSON.stringify(token)}.`);
    const name = token.slice(2);
    if (booleans.includes(name)) {
      flags[name] = '';
      continue;
    }
    if (!valued.includes(name)) throw new CliUsageError(`Unknown argument ${JSON.stringify(token)}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliUsageError(`${token} expects a value.`);
    }
    if (flags[name] !== undefined) throw new CliUsageError(`${token} may be specified only once.`);
    flags[name] = value;
    index += 1;
  }
  return flags;
}

export interface TrajectoryIo {
  projectRoot: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Runs one parsed command and returns the process exit code. */
export async function runTrajectoryCommand(
  command: TrajectoryCommand,
  io: TrajectoryIo,
): Promise<number> {
  switch (command.verb) {
    case 'list':
      return listSessions(io);
    case 'search':
      return search(command, io);
    case 'replay':
      return replay(command, io);
    case 'fork':
      return fork(command, io);
  }
}

async function listSessions(io: TrajectoryIo): Promise<number> {
  const ids = await listSessionIds(io.projectRoot);
  if (ids.length === 0) {
    io.out('no sessions recorded for this project\n');
    return 0;
  }

  for (const id of ids) {
    const file = trajectoryPath(io.projectRoot, id);
    let summary: string;
    try {
      const read = await readTrajectory(file);
      const damage = describeDamage(read);
      const turns = new Set(read.records.filter((r) => r.turn > 0).map((r) => r.turn)).size;
      summary =
        `${read.records.length} record(s), ${turns} turn(s), ${read.bytes} bytes` +
        (damage === undefined ? '' : ` — ${damage}`);
    } catch {
      // A snapshot without a record is the ordinary case for sessions that predate
      // recording or ran with it off; say which, rather than implying an empty run.
      summary = (await hasSnapshot(io.projectRoot, id, AGENT_ID))
        ? 'no trajectory recorded (snapshot only)'
        : 'no trajectory recorded';
    }
    io.out(`${id}  ${summary}\n`);
  }
  return 0;
}

async function search(
  command: Extract<TrajectoryCommand, { verb: 'search' }>,
  io: TrajectoryIo,
): Promise<number> {
  const options: Parameters<typeof searchTrajectories>[3] = {};
  if (command.sessionId !== undefined) options.sessionId = command.sessionId;
  if (command.type !== undefined) options.type = command.type;
  if (command.limit !== undefined) options.limit = command.limit;

  let outcome;
  try {
    outcome = await searchTrajectories(io.projectRoot, command.query, AGENT_ID, options);
  } catch (error) {
    if (error instanceof UnknownSessionError) {
      io.err(`error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  // An explicitly named session with no record is a different answer from "no
  // matches", and gets its own exit code: the search never ran over anything.
  if (command.sessionId !== undefined && outcome.withoutRecord.includes(command.sessionId)) {
    io.err(`error: no trajectory recorded for session ${command.sessionId}\n`);
    return 1;
  }

  for (const session of outcome.sessions) {
    if (session.damage !== undefined) io.err(`${session.sessionId}: ${session.damage}\n`);
    for (const hit of session.hits) {
      io.out(`${hit.sessionId} seq=${hit.seq} turn=${hit.turn} ${hit.type} — ${hit.excerpt}\n`);
    }
  }

  if (outcome.hitCount === 0) {
    // Exit 0: the search itself succeeded. Only a record that could not be read is
    // a failure, and that was reported above.
    io.out(`no matches for ${JSON.stringify(command.query)}\n`);
    if (outcome.withoutRecord.length > 0) {
      io.err(`${outcome.withoutRecord.length} session(s) have no trajectory record\n`);
    }
    return 0;
  }

  io.out(`${outcome.hitCount} match(es)${outcome.limited ? ' (limit reached)' : ''}\n`);
  return 0;
}

async function replay(
  command: Extract<TrajectoryCommand, { verb: 'replay' }>,
  io: TrajectoryIo,
): Promise<number> {
  let read;
  try {
    read = await readTrajectory(trajectoryPath(io.projectRoot, command.sessionId));
  } catch (error) {
    if (error instanceof TrajectoryMissingError) {
      const known = await hasSnapshot(io.projectRoot, command.sessionId, AGENT_ID);
      io.err(
        `error: no trajectory recorded for session ${command.sessionId}` +
          `${known ? ' (the session exists but predates recording, or ran with trajectory: false)' : ''}\n`,
      );
      return 1;
    }
    throw error;
  }

  const result = replayRead(read, command.turn === undefined ? {} : { turn: command.turn });
  if (result.damage !== undefined) io.err(`${command.sessionId}: ${result.damage}\n`);
  if (command.turn !== undefined && !result.turns.includes(command.turn)) {
    io.err(
      `error: session ${command.sessionId} has no turn ${command.turn}` +
        ` (recorded turns: ${result.turns.join(', ') || 'none'})\n`,
    );
    return 1;
  }

  io.out(command.json ? `${JSON.stringify(result.history, null, 2)}\n` : `${formatReplay(result)}\n`);
  return 0;
}

async function fork(
  command: Extract<TrajectoryCommand, { verb: 'fork' }>,
  io: TrajectoryIo,
): Promise<number> {
  let result;
  try {
    result = await forkSession(io.projectRoot, command.sessionId, AGENT_ID);
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // The id goes to stdout alone, so `$(darwin trajectory fork <id>)` is usable;
  // everything explanatory is a stderr diagnostic, as in headless mode.
  io.out(`${result.sessionId}\n`);
  io.err(`forked ${result.sourceId} → ${result.sessionId}\n`);
  for (const copied of result.copied) io.err(`  copied ${copied}\n`);
  if (!result.trajectoryCopied) io.err('  source had no trajectory record to carry over\n');
  io.err(`  open it with: darwin --session ${result.sessionId}\n`);
  return 0;
}

#!/usr/bin/env node
/**
 * Locates the trajectory file of the darwin session that is running right now in
 * this project, so the self-reflection skill can hand its child an exact subject.
 *
 * Read-only by construction: the script opens files, writes nothing, and never
 * touches the resume pointer. Selection is "newest trajectory.jsonl by mtime"
 * because the Host's own prompt was appended to its record synchronously at send
 * time — run this BEFORE launching any child, and the newest record is the Host's.
 * The printed `last-user-input:` preview exists so the caller can verify that
 * instead of trusting the heuristic.
 *
 * Usage:
 *   node locate-trajectory.mjs [--project <root>] [--session <id>]
 *
 * `--session` pins an explicit session and refuses a missing one rather than
 * falling back; `--project` defaults to the current working directory.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const TRAJECTORY_FILENAME = 'trajectory.jsonl';
const PREVIEW_CODE_POINTS = 160;

/** Mirrors `projectKey` in `src/paths.ts`; keep the two in step. */
function projectKey(projectRoot) {
  let canonical;
  try {
    canonical = realpathSync.native(projectRoot);
  } catch {
    canonical = path.resolve(projectRoot);
  }
  const readable = canonical.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 180) || 'project';
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `${readable}--${digest}`;
}

function fail(message) {
  console.error(`locate-trajectory: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { project: process.cwd(), session: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project' && argv[i + 1] !== undefined) {
      args.project = argv[(i += 1)];
    } else if (argv[i] === '--session' && argv[i + 1] !== undefined) {
      args.session = argv[(i += 1)];
    } else {
      fail(`unknown or incomplete argument ${JSON.stringify(argv[i])}`);
    }
  }
  return args;
}

/** The last `userInput` record's text, truncated for a one-line preview. */
function lastUserInputPreview(trajectoryFile) {
  let raw;
  try {
    raw = readFileSync(trajectoryFile, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of raw.split('\n').reverse()) {
    if (!line.includes('"userInput"')) continue;
    try {
      const record = JSON.parse(line);
      if (record.type !== 'userInput' || typeof record.text !== 'string') continue;
      const flat = record.text.replace(/\s+/g, ' ').trim();
      const points = [...flat];
      return points.length > PREVIEW_CODE_POINTS
        ? `${points.slice(0, PREVIEW_CODE_POINTS).join('')}…`
        : flat;
    } catch {
      // A half-written or corrupt line is tolerated, never repaired.
    }
  }
  return undefined;
}

const args = parseArgs(process.argv.slice(2));
const sessionsDir = path.join(os.homedir(), '.darwin', 'sessions', projectKey(args.project));

let entries;
try {
  entries = readdirSync(sessionsDir, { withFileTypes: true });
} catch {
  fail(`no session state for this project at ${sessionsDir} — nothing to reflect on`);
}

const candidates = [];
for (const entry of entries) {
  if (!entry.isDirectory() || entry.name === 'session') continue;
  if (!/^[a-z0-9_-]+$/.test(entry.name)) continue;
  const trajectoryFile = path.join(sessionsDir, entry.name, TRAJECTORY_FILENAME);
  if (!existsSync(trajectoryFile)) continue;
  candidates.push({
    session: entry.name,
    trajectoryFile,
    mtime: statSync(trajectoryFile).mtime,
  });
}

if (candidates.length === 0) {
  fail(`no trajectory.jsonl under ${sessionsDir} — recording may be off (trajectory: false)`);
}
candidates.sort((left, right) => right.mtime.getTime() - left.mtime.getTime());

let selected;
let selectedBy;
if (args.session !== undefined) {
  selected = candidates.find((candidate) => candidate.session === args.session);
  if (selected === undefined) {
    fail(`session ${JSON.stringify(args.session)} has no trajectory in ${sessionsDir}`);
  }
  selectedBy = 'explicit --session';
} else {
  [selected] = candidates;
  selectedBy = 'newest trajectory mtime';
}

const preview = lastUserInputPreview(selected.trajectoryFile);
console.log(`project-root: ${args.project}`);
console.log(`sessions-dir: ${sessionsDir}`);
console.log(`session: ${selected.session}`);
console.log(`trajectory: ${selected.trajectoryFile}`);
console.log(`selected-by: ${selectedBy}`);
console.log(`trajectory-mtime: ${selected.mtime.toISOString()}`);
console.log(`last-user-input: ${preview ?? '(none recorded)'}`);
const others = candidates.filter((candidate) => candidate !== selected).slice(0, 5);
console.log(`other-recent-sessions: ${others.length === 0 ? '(none)' : ''}`);
for (const other of others) {
  console.log(`  ${other.session} (${other.mtime.toISOString()})`);
}

/**
 * Drives the dev REPL as a subprocess for end-to-end checks.
 *
 * Answers prompts reactively — writing to stdin only once the corresponding
 * prompt has appeared. A pre-written script does not work: readline discards
 * incoming lines while no question is pending, so buffered answers vanish and
 * every permission prompt would default to deny.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const YOU_PROMPT = 'you> ';
const ALLOW_PROMPT = 'allow? [y/N]';

export interface ReplRun {
  transcript: string;
  exitCode: number | null;
}

export interface ReplOptions {
  /** Directory the REPL treats as the project root. */
  cwd: string;
  args?: string[];
  /** One entry per `you>` prompt; `/exit` is sent once these run out. */
  turns: string[];
  permissionAnswer: 'y' | 'n';
  timeoutMs: number;
  /** Echo the child's output. Defaults to true. */
  echo?: boolean;
}

export function runRepl(options: ReplOptions): Promise<ReplRun> {
  return new Promise((resolve, reject) => {
    // The repo's tsx binary by absolute path: the child's cwd is the project
    // under test, so a bare `tsx` would not resolve from there.
    const child = spawn(
      path.join(REPO_ROOT, 'node_modules/.bin/tsx'),
      [path.join(REPO_ROOT, 'src/dev-repl.ts'), ...(options.args ?? [])],
      { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env },
    );

    let transcript = '';
    const remaining = [...options.turns];
    let answeredAllow = 0;
    let servedYou = 0;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`REPL timed out after ${options.timeoutMs}ms. Transcript:\n${transcript}`));
    }, options.timeoutMs);

    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      transcript += text;
      if (options.echo !== false) process.stdout.write(text);

      // Answer permission prompts first: a pending confirmation blocks the turn
      // that would otherwise produce the next `you>`.
      const allowCount = occurrences(transcript, ALLOW_PROMPT);
      while (answeredAllow < allowCount) {
        answeredAllow += 1;
        child.stdin.write(`${options.permissionAnswer}\n`);
      }

      const youCount = occurrences(transcript, YOU_PROMPT);
      while (servedYou < youCount) {
        servedYou += 1;
        child.stdin.write(`${remaining.shift() ?? '/exit'}\n`);
      }
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ transcript, exitCode });
    });
  });
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

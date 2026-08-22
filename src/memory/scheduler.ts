import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { projectMemoryDir, userProjectSessionsDir } from '../paths.js';
import { rebuildMemoryStore, type MemoryStatus } from './store.js';

export const MEMORY_JOB_DELAY_MS = 25;
export const MEMORY_JOB_TIMEOUT_MS = 2_000;
export const MEMORY_MAX_QUEUED_RERUNS = 1;
export const MEMORY_PROBLEM_MAX_CODE_POINTS = 240;

export interface MemorySchedulerOptions {
  readonly projectRoot: string;
  readonly delayMs?: number;
  readonly timeoutMs?: number;
  readonly discover?: () => Promise<readonly { session: string; file: string }[]>;
  readonly rebuild?: typeof rebuildMemoryStore;
}

/** Detached, coalescing post-turn derivation. schedule() is synchronous and no-throw. */
export class MemoryScheduler {
  private problem: string | undefined;
  private pressureProblem: string | undefined;
  private running = false;
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: Promise<void> = Promise.resolve();
  private droppedJobs = 0;
  private closed = false;

  constructor(private readonly options: MemorySchedulerOptions) {}

  schedule(): void {
    if (this.closed || this.problem !== undefined) return;
    try {
      if (this.running || this.timer !== undefined) {
        if (this.queued) {
          this.droppedJobs += 1;
          this.pressureProblem ??= 'learned-memory queue pressure coalesced one or more scans';
        }
        this.queued = true;
        return;
      }
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.current = this.run();
      }, this.options.delayMs ?? MEMORY_JOB_DELAY_MS);
      this.timer.unref?.();
    } catch (error) {
      this.latch(error);
    }
  }

  get status(): MemoryStatus {
    return {
      directory: projectMemoryDir(this.options.projectRoot),
      problem: this.problem ?? this.pressureProblem,
      pending: this.running || this.timer !== undefined || this.queued,
      droppedJobs: this.droppedJobs,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queued = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.closed = false;
      await this.run();
      this.closed = true;
    }
    await this.current;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const task = (async () => {
        const sources = await (this.options.discover?.() ?? discoverTrajectories(this.options.projectRoot));
        await (this.options.rebuild ?? rebuildMemoryStore)(this.options.projectRoot, sources);
      })();
      task.catch(() => {});
      await withTimeout(task, this.options.timeoutMs ?? MEMORY_JOB_TIMEOUT_MS);
    } catch (error) {
      this.latch(error);
    } finally {
      this.running = false;
      if (this.queued) {
        this.queued = false;
        this.schedule();
      }
    }
  }

  private latch(error: unknown): void {
    if (this.problem !== undefined) return;
    let message: string;
    try {
      message = error instanceof Error ? error.message : String(error);
    } catch {
      message = 'learned-memory extraction failed with an unreadable error';
    }
    const collapsed = message.replace(/\s+/g, ' ').trim() || 'learned-memory extraction failed';
    const points = [...collapsed];
    this.problem = points.length <= MEMORY_PROBLEM_MAX_CODE_POINTS
      ? collapsed
      : `${points.slice(0, MEMORY_PROBLEM_MAX_CODE_POINTS - 1).join('')}…`;
  }
}

async function discoverTrajectories(projectRoot: string): Promise<{ session: string; file: string }[]> {
  const root = userProjectSessionsDir(projectRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
    .map((entry) => ({ session: entry.name, file: path.join(root, entry.name, 'trajectory.jsonl') }));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`learned-memory extraction timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

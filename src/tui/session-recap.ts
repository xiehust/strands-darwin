/** Pure away/return state. Clock supplied by the owner; no timers, filesystem or Agent. */
import type { RecapEvidence, RecapResult } from '../agent/session-recap.js';
import { recapTail } from '../agent/session-recap.js';
export const RECAP_AWAY_MS = 180_000;
export const RECAP_MIN_TURNS = 3;

export class SessionRecapState {
  private exchanges: { user: string; assistant: string }[] = [];
  private truncated = false;
  private turns = 0;
  private humanCompleted = false;
  private completedAt = 0;
  private generation = 0;
  private attempted = -1;
  private revision = 0;
  private focused: boolean | undefined;
  private active: AbortController | undefined;
  private prepared: { result: RecapResult; evidence: RecapEvidence } | undefined;
  private key = '';
  private cause = '';
  private failures = 0;
  constructor(private readonly now: () => number = Date.now) {}
  get pending(): boolean { return this.active !== undefined; }
  get evidence(): RecapEvidence { return { exchanges: this.exchanges.map(pair => ({ ...pair })), truncated: this.truncated }; }

  invalidate(): void {
    this.revision++;
    this.active?.abort();
    this.active = undefined;
    this.prepared = undefined;
  }
  workStarted(): void { this.invalidate(); this.humanCompleted = false; }
  resetSession(): void {
    this.invalidate(); this.exchanges = []; this.truncated = false; this.turns = 0;
    this.generation++; this.focused = undefined; this.humanCompleted = false;
    // App-owned failure suspension deliberately survives clear/rewind.
  }
  configure(key: string): void {
    if (key === this.key) return;
    this.invalidate(); this.key = key; this.failures = 0; this.cause = '';
  }
  complete(user: string, assistant: string, alreadyTruncated = false): void {
    this.invalidate();
    const u = recapTail(user, 800), a = recapTail(assistant, 1600);
    this.truncated ||= alreadyTruncated || u.truncated || a.truncated || this.exchanges.length >= 6;
    this.exchanges = [...this.exchanges.slice(-5), { user: u.text, assistant: a.text }];
    this.turns++; this.generation++; this.completedAt = this.now(); this.humanCompleted = true;
  }
  /** Only a real blur -> focus transition may consume a prepared generation. */
  focus(focused: boolean | undefined, unowned: boolean): { result: RecapResult; evidence: RecapEvidence } | undefined {
    const returning = this.focused === false && focused === true;
    this.focused = focused;
    const prepared = returning && unowned ? this.prepared : undefined;
    if (focused !== false) this.invalidate();
    return prepared;
  }

  delay(enabled: boolean, unowned: boolean): number | undefined {
    if (!enabled || !unowned || !this.humanCompleted || this.focused !== false || this.turns < RECAP_MIN_TURNS || this.attempted === this.generation || this.failures >= 3) return undefined;
    return Math.max(0, this.completedAt + RECAP_AWAY_MS - this.now());
  }
  async generate(
    manual: boolean, enabled: boolean, unowned: boolean,
    request: (evidence: RecapEvidence, signal: AbortSignal) => Promise<RecapResult>,
    settled: (result: RecapResult, evidence: RecapEvidence, publish: boolean, suspension?: string) => void,
  ): Promise<void> {
    if (!unowned || this.pending || this.exchanges.length === 0 || (!manual && this.delay(enabled, unowned) !== 0)) return;
    this.attempted = this.generation; // Also prevents automatic replay of a manually recapped state.
    const revision = this.revision, key = this.key, evidence = this.evidence;
    const controller = new AbortController();
    this.active = controller;
    let result: RecapResult;
    try { result = await request(evidence, controller.signal); }
    catch { result = { problem: 'recap generation failed' }; }
    if (this.active === controller) this.active = undefined;
    const current = revision === this.revision && !controller.signal.aborted && !result.cancelled;
    let suspension: string | undefined;
    if (current && key === this.key && !manual) {
      if (result.problem !== undefined) {
        this.failures = this.cause === result.problem ? this.failures + 1 : 1;
        this.cause = result.problem;
        if (this.failures === 3) suspension = `Automatic session recaps paused after 3 same-cause failures: ${this.cause}. Change model/config or restart to re-enable. Manual /recap remains explicit.`;
      } else { this.failures = 0; this.cause = ''; }
    }
    if (current && !manual && this.focused === false && result.text !== undefined) this.prepared = { result, evidence };
    settled(current ? result : { ...result, cancelled: true }, evidence, current && manual, suspension);
  }
}

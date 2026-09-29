/**
 * `/goal <condition>` (SER-108): condition-checked self-continuation, as pure state.
 *
 * Nothing here is I/O and nothing here decides *when* the App runs anything: the App
 * owns the effects and the model call; this module owns the state machine, the grammar,
 * the bounded evidence and prompt text, and the one-line projections the header, the busy
 * hint and the transcript share with the tests.
 *
 * The whole feature is one small loop layered on the prompt-queue idle seam, never a
 * second scheduler and never inside the SDK agent loop:
 *
 *   completed turn -> `check-due` -> (idle, queue empty, no peer, no permission) one
 *   bounded check -> unmet & under the cap -> `continue-due` -> the same idle conditions
 *   -> exactly one continuation prompt through the ordinary `submit()` -> completed turn.
 *
 * Every arrow that starts model work is gated on the same "nothing else wants the session"
 * predicate ({@link goalAction}); a queued prompt, `!` command, task/delegation wake or
 * peer message always goes first, and the goal simply waits for the next idle moment.
 * A cancel or failure of goal-owned work clears the goal: the user's Ctrl+C is final.
 */

import { GOAL_USAGE } from '../commands/goal-command.js';

/** Consecutive automatic continuations before the goal stops and asks the user. */
export const GOAL_MAX_CONTINUATIONS = 5;
/** The tail of the turn's answer text the check may read, in code points. */
export const GOAL_EVIDENCE_TEXT_MAX_CODE_POINTS = 6000;
/** The most recent tool calls the check may read. */
export const GOAL_EVIDENCE_MAX_TOOLS = 30;

export type GoalPhase =
  /** Set; waiting for a turn to complete. */
  | 'armed'
  /** A turn completed; one check is owed at the next idle moment. */
  | 'check-due'
  /** The check model call is in flight (the session is busy). */
  | 'checking'
  /** The check said unmet; one continuation is owed at the next idle moment. */
  | 'continue-due'
  /** A continuation turn was submitted and is running or about to. */
  | 'continuing'
  /** The cap was reached with the goal still unmet; nothing continues until the user acts. */
  | 'capped';

export interface GoalState {
  readonly condition: string;
  /** Automatic continuations submitted since the last user-typed turn. */
  readonly continuations: number;
  readonly phase: GoalPhase;
  /** The last unmet verdict's bounded reason: what the owed continuation prompt quotes. */
  readonly note?: string;
}

export function newGoal(condition: string): GoalState {
  return { condition, continuations: 0, phase: 'armed' };
}

/** Who started a turn: the user, this loop, or the session itself (task/delegation wake, peer). */
export type GoalTurnKind = 'user' | 'goal' | 'session';
export type GoalTurnOutcome = 'completed' | 'cancelled' | 'failed';

export interface GoalNotice {
  readonly text: string;
  readonly severity?: 'warn';
}

export interface GoalTransition {
  readonly goal: GoalState | undefined;
  readonly notice?: GoalNotice;
}

/**
 * A turn is about to start. An owed check or continuation belonged to the idle moment
 * that is now over: the starting turn's own completion re-decides, so a stale result
 * can never start work on top of newer work.
 */
export function goalBeforeTurn(goal: GoalState, kind: GoalTurnKind): GoalState {
  if (kind === 'goal') return goal;
  return goal.phase === 'check-due' || goal.phase === 'continue-due' ? { ...goal, phase: 'armed' } : goal;
}

/** A turn ended. Cancelled or failed goal-owned work clears the goal; nothing else auto-continues. */
export function goalAfterTurn(goal: GoalState, kind: GoalTurnKind, outcome: GoalTurnOutcome): GoalTransition {
  if (outcome !== 'completed') {
    if (kind === 'goal') {
      return {
        goal: undefined,
        notice: {
          text: `goal cleared — the automatic continuation was ${outcome === 'cancelled' ? 'cancelled' : 'stopped by a failure'}; set it again with /goal <condition>`,
          severity: 'warn',
        },
      };
    }
    return { goal: { ...goal, phase: goal.phase === 'capped' ? 'capped' : 'armed' } };
  }
  if (kind === 'user') return { goal: { ...goal, continuations: 0, phase: 'check-due' } };
  if (kind === 'session' && goal.phase === 'capped') return { goal };
  return { goal: { ...goal, phase: 'check-due' } };
}

export type GoalCheckResult =
  | { readonly kind: 'verdict'; readonly met: boolean; readonly reason: string; readonly inputTokens?: number; readonly outputTokens?: number }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly message: string };

/** What the check's `not reported` spend reads as: never 0 for a metric the provider did not send. */
export function goalCheckSpend(inputTokens: number | undefined, outputTokens: number | undefined): string {
  if (inputTokens === undefined || outputTokens === undefined) return 'check tokens not reported';
  return `check ${inputTokens} in / ${outputTokens} out tokens`;
}

/** The check finished (or did not). The transition and the one transcript notice that states it. */
export function goalAfterCheck(goal: GoalState, result: GoalCheckResult): GoalTransition {
  if (result.kind === 'cancelled') {
    return { goal: undefined, notice: { text: 'goal check cancelled — goal cleared; set it again with /goal <condition>', severity: 'warn' } };
  }
  if (result.kind === 'error') {
    return {
      goal: { ...goal, phase: 'armed' },
      notice: {
        text: `goal check failed: ${result.message} — no continuation started; the next completed turn checks again`,
        severity: 'warn',
      },
    };
  }
  const spend = goalCheckSpend(result.inputTokens, result.outputTokens);
  if (result.met) {
    return { goal: undefined, notice: { text: `goal met · ${result.reason} (${spend})` } };
  }
  if (goal.continuations >= GOAL_MAX_CONTINUATIONS) {
    return {
      goal: { ...goal, phase: 'capped' },
      notice: {
        text:
          `goal not met · ${result.reason} (${spend}) — stopped after ${goal.continuations} automatic ` +
          `continuation${goal.continuations === 1 ? '' : 's'}; send a prompt to check again, or /goal off`,
        severity: 'warn',
      },
    };
  }
  return {
    goal: { ...goal, phase: 'continue-due', note: result.reason },
    notice: { text: `goal not met · ${result.reason} (${spend}) — continuing ${goal.continuations + 1}/${GOAL_MAX_CONTINUATIONS}` },
  };
}

export type GoalAction = 'none' | 'check' | 'continue';

export interface GoalIdleContext {
  readonly idle: boolean;
  readonly permissionPending: boolean;
  readonly clearing: boolean;
  /** A queue entry or peer message is already in flight through the drain latch. */
  readonly draining: boolean;
  /** Queued user entries, `!` commands and wakes together. */
  readonly queued: number;
  readonly peerPending: number;
}

/**
 * What the goal may start right now. Model work starts only when the session is idle
 * and nothing else wants it: no permission decision, no `/clear` assembly, no drained
 * entry in flight, an empty queue and an empty peer inbox. Otherwise `none` — the
 * other owner goes first, and the goal is re-asked at the next idle moment.
 */
export function goalAction(goal: GoalState | undefined, context: GoalIdleContext): GoalAction {
  if (goal === undefined) return 'none';
  if (!context.idle || context.permissionPending || context.clearing || context.draining) return 'none';
  if (context.queued > 0 || context.peerPending > 0) return 'none';
  if (goal.phase === 'check-due') return 'check';
  if (goal.phase === 'continue-due') return 'continue';
  return 'none';
}

/** The state after the continuation is submitted (the counter moves at dispatch, not at completion). */
export function goalContinued(goal: GoalState): GoalState {
  return { ...goal, continuations: goal.continuations + 1, phase: 'continuing' };
}

/**
 * The one continuation prompt. The condition is the user's own text and the reason is
 * the check's bounded, control-stripped sentence; both are stated as such.
 */
export function goalContinuationPrompt(condition: string, reason: string): string {
  return (
    `The goal set for this session is not yet met: ${condition}\n` +
    `Goal check note: ${reason}\n` +
    'Continue working toward it. When it holds, say so and give the evidence; ' +
    'if you are blocked, say what blocks you instead of guessing.'
  );
}

/** `goal <phase>` fragment shared by the header state word and the busy hint. */
function goalPhrase(goal: GoalState): string {
  switch (goal.phase) {
    case 'armed':
      return goal.continuations === 0 ? 'goal armed' : `goal ${goal.continuations}/${GOAL_MAX_CONTINUATIONS}`;
    case 'check-due':
    case 'checking':
      return 'goal checking';
    case 'continue-due':
      return `goal continuing ${goal.continuations + 1}/${GOAL_MAX_CONTINUATIONS}`;
    case 'continuing':
      return `goal continuing ${goal.continuations}/${GOAL_MAX_CONTINUATIONS}`;
    case 'capped':
      return `goal capped ${goal.continuations}/${GOAL_MAX_CONTINUATIONS}`;
  }
}

/** Appended to the header's existing state word and the busy hint; no row of its own. */
export function goalLiveSuffix(goal: GoalState | undefined): string {
  return goal === undefined ? '' : ` · ${goalPhrase(goal)}`;
}

/** Bare `/goal`: the condition, where the loop is, and the exits. */
export function goalStatusText(goal: GoalState | undefined): string {
  if (goal === undefined) return `goal: none set — ${GOAL_USAGE}`;
  const where =
    goal.phase === 'armed'
      ? 'checked after the next completed turn'
      : goal.phase === 'check-due' || goal.phase === 'checking'
        ? 'being checked now'
        : goal.phase === 'continue-due' || goal.phase === 'continuing'
          ? 'not met; continuing automatically'
          : 'stopped at the continuation cap; a prompt from you checks it again';
  return (
    `goal: ${goal.condition}\n` +
    `  ${goal.continuations}/${GOAL_MAX_CONTINUATIONS} automatic continuations · ${where} · /goal off clears`
  );
}

export const GOAL_SET_NOTICE = (condition: string, replaced: boolean): string =>
  `goal ${replaced ? 'replaced' : 'set'}: ${condition}\n` +
  `  checked once after each completed turn by a small model; if unmet, up to ${GOAL_MAX_CONTINUATIONS} automatic ` +
  'continuations follow. Ctrl+C or /goal off stops it; /clear drops it.';

export interface GoalToolCall {
  readonly name: string;
  readonly status: 'success' | 'error';
}

/**
 * The bounded record the check reads: the most recent tool calls and the tail of the
 * turn's answer text. Both caps state what they cut, so the checker knows the record
 * is partial rather than concluding from silence.
 */
export function composeGoalEvidence(answers: readonly string[], tools: readonly GoalToolCall[]): string {
  const shownTools = tools.slice(-GOAL_EVIDENCE_MAX_TOOLS);
  const toolLines = shownTools.map((tool) => `- ${tool.name}: ${tool.status === 'success' ? 'ok' : 'error'}`);
  if (tools.length > shownTools.length) toolLines.unshift(`(${tools.length - shownTools.length} earlier tool calls not shown)`);
  const joined = answers.join('\n').trim();
  const points = Array.from(joined);
  const text =
    points.length > GOAL_EVIDENCE_TEXT_MAX_CODE_POINTS
      ? `(earlier answer text not shown)\n${points.slice(points.length - GOAL_EVIDENCE_TEXT_MAX_CODE_POINTS).join('')}`
      : joined;
  return `tools:\n${toolLines.length === 0 ? '(none)' : toolLines.join('\n')}\n\nfinal answer:\n${text === '' ? '(no answer text)' : text}`;
}

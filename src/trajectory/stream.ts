/**
 * The observer seam itself: one generator that records a stream while passing it
 * through unchanged.
 *
 * It exists as its own function for two reasons. `AgentRuntime.send` stays a
 * two-line delegation, and — more importantly — the pass-through property becomes
 * something a test can drive over a *real* `Agent.stream()`, rather than a claim
 * about code only a live model can reach.
 *
 * The rules it has to keep:
 *
 * - every event is yielded, in order, unmodified;
 * - nothing is awaited between receiving an event and yielding it;
 * - `record()` and `failed()` cannot throw (they catch internally), so no recording
 *   failure can surface as a turn failure;
 * - a thrown stream is observed and **rethrown as the identical object**: the caller
 *   sees the same class, the same message and the same stack it would have seen with
 *   recording switched off;
 * - a consumer that stops early still closes the underlying stream, and the turn is
 *   still closed off, which is what makes a cancelled turn leave a valid record.
 *
 * `for await` + `yield` is used rather than `yield*` because a delegation cannot be
 * observed from inside. The observable semantics darwin's consumers rely on are the
 * same either way — order, completion, throw propagation, and iterator closing on an
 * early `break` — and `spike/verify-trajectory.ts` measures that against the SDK's
 * own stream instead of assuming it.
 */
import type { AgentStreamEvent } from '@strands-agents/sdk';

import type { TurnRecording } from './writer.js';

export async function* recordStream(
  events: AsyncIterable<AgentStreamEvent>,
  turn: TurnRecording | undefined,
): AsyncIterable<AgentStreamEvent> {
  try {
    for await (const event of events) {
      turn?.record(event);
      yield event;
    }
  } catch (error) {
    // The one place the record learns that a turn *failed* rather than merely ended:
    // a thrown turn emits no `agentResultEvent`, so without this the line closing it
    // would be indistinguishable from a cancelled or an abandoned turn. `catch` runs
    // before `finally`, so the `end()` below writes the failure out.
    //
    // Rethrowing the same object — not a copy, not a wrapper — is the observer
    // contract: what the caller of `AgentRuntime.send` sees must not depend on whether
    // recording is on. A consumer-side error is deliberately *not* seen here, because
    // JavaScript delivers a for-await body's throw to this generator as a `return`
    // completion: that runs the `finally` alone and the turn is recorded as abandoned,
    // which is what it is — the turn did not fail, the reader left.
    turn?.failed(error);
    throw error;
  } finally {
    // Reached on normal completion, on a throw, and when the consumer stops early
    // (`break`, or a cancelled turn): the record must describe what happened either
    // way. The append it schedules is never awaited here.
    turn?.end();
  }
}

# Design

## Extension seam

Patch the pinned SDK vended bash session rather than wrapping error text in Darwin. `src/tools/background-bash.ts` delegates foreground execute/restart directly with the caller's `ToolContext`; only the SDK owns the child process, buffers, close event, and per-Agent WeakMap. Darwin cannot recover the command's output or true close signal from the current thrown string.

The repository already applies `patches/@strands-agents__sdk@1.12.0.patch`, so extending that patch is the smallest established seam and leaves the SDK agent loop untouched.

## Per-Agent serialization

Add a promise tail to each SDK `BashSession`. Public `run()` and `restart` enqueue against that tail. The queue must continue after rejection so one nonzero/signal failure cannot poison later calls. This makes the persistent stream/sentinel protocol single-flight while preserving concurrency across distinct Agent sessions.

Queue explicit restart with execute calls on the same session. Restart still deletes the old WeakMap entry and installs a fresh lazy session after the queued stop, preserving Darwin runtime cleanup. A command which closes the process naturally resets `_started`; the following queued command calls `start()` and gets a healthy process.

## Close semantics and metadata

On child `close(code, signal)`, perform command-listener cleanup after Node has closed stdout/stderr. Build the result from that invocation's captured buffers:

- `code === 0 && signal === null`: resolve `{ output, error }`, appending a visible line to `error` that states the persistent shell exited and will restart on the next command.
- Otherwise reject `BashSessionError` with `exitCode`, `signal`, `output`, and `error` properties. The message names the true code and signal.

The success notice belongs in stderr because it is operational metadata, not command stdout. Existing normal sentinel completion remains byte-compatible.

## Regression coverage

Extend `spike/verify-background-bash.ts` through the public Darwin wrapper and real SDK process:

1. Prove the pre-fix race shape conceptually with parallel calls but assert the fixed behavior: invocation-ordered, disjoint stdout/stderr, including an exit-0 call and a successful next command.
2. Prove normal persistent state and explicit restart remain compatible.
3. Prove nonzero and signalled exits retain captured output and true metadata and that a later command still works.
4. Keep the suite's existing per-Agent isolation, background wait, shutdown, natural-exit descendant, TERM-to-KILL, and exit-fallback checks.

Then run the architecture-named free process probes and project gates once source settles.

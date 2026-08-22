# Design

## Boundary

The current behavior gap lives in `runInteractive`: Ink and `App` are imported first, but no renderer owns the terminal until runtime and optional recap initialization finish. The smallest change is to render a dedicated pre-App component on one Ink instance, update its honest phase during recap work, and `rerender` that same instance with the unchanged `App` when ready.

Expected source changes:

- `src/tui/StartupScreen.tsx`: isolated bounded presentation and timer lifecycle; no input hooks or output writes.
- `src/cli.ts`: start Ink before runtime creation, update startup phase, rerender to `App`, and unmount on initialization errors.
- `spike/verify-startup-screen.tsx`: deterministic component/lifecycle contracts.
- `spike/fixtures/startup-cli.ts` and `spike/verify-startup-pty.ts`: offline real-pty delayed, error, and resume handoff verification.
- `spike/run-tests.ts`: include the deterministic fast suite(s).
- `.trellis/spec/frontend/live-frame.md` and `tui-testing.md`: record the pre-App ownership and pty acceptance contract.
- `docs/research/backlog_index.md`: append implementation evidence while leaving SER-035 in progress for Host acceptance.

Explicitly excluded: changes inside `App`, permanent frame furniture, a second renderer, raw stdout animation, a fixed minimum duration, runtime internals, provider calls, dependencies, or unrelated SER-034 vocabulary.

## Lifecycle

1. Dynamically import Ink, React, `StartupScreen`, `App`, and `PermissionQueue`.
2. Immediately call `render(<StartupScreen phase="runtime" />)` with `exitOnCtrlC: false`.
3. Await the existing runtime factory. On a known startup error, unmount the Ink instance before printing the existing stderr message. On an unexpected error, unmount and rethrow.
4. If resumed, rerender startup with `phase="resume"`, then await the existing recap loader.
5. Rerender the same instance with the ordinary `App` props. React unmount cleanup clears the startup interval before the settled frame owns input.
6. Keep existing `waitUntilExit`, permission close, runtime shutdown, and forced-exit ownership unchanged.

## Responsive surface

The component reads Ink `useWindowSize` and renders at most three one-line `Text` rows when both width and height permit. Short or narrow terminals render one compact line. Every frame includes a stable `◆ darwin` identity and explicit `initializing` or `restoring session` state. A bounded glyph sequence supplies motion; no progress percentage or fabricated stage is shown.

The component owns one interval only while mounted. Its frame index wraps through a fixed sequence and cleanup always clears the interval. It has no `useInput`, `usePaste`, `useStdout`, or Node process/stdout access.

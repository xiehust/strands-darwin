# Implementation plan

1. Add the bounded startup component and deterministic render/timer tests.
2. Wire the single Ink instance around runtime and recap initialization with clean failure unmount.
3. Add an offline delayed-runtime CLI fixture and real-pty checks for pending motion, handoff, usable input, known startup error, and resume byte stability.
4. Run focused startup, frame-budget, visual-language, and free pty completion/clear/resume checks; fix locally.
5. Update frontend specs and in-progress backlog evidence.
6. Run `pnpm typecheck`, then one full `pnpm test`; review diff and commit source/docs/task work.
7. Archive the task and record the Trellis journal. Do not mark SER-035 done and do not update `docs/iteration-log.md`; Host acceptance owns both.

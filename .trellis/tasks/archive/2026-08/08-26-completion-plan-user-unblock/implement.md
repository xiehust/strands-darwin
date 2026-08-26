# Implementation plan — remove completion guard

1. Remove the guard module and focused suite registration; remove all imports/callers.
2. Restore direct TUI/headless/structured event consumption through existing stream-resumption orchestration.
3. Remove runtime private-turn and trajectory deferred/suppression surfaces plus the reducer's buffered terminal action.
4. Update update-plan reducer/pty tests so unfinished plans end normally and a delayed fixture proves tool/plan/text visibility before terminal completion without duplication.
5. Remove completion-guard load-bearing index, architecture, backend trajectory/headless, and frontend transaction contracts; document ordinary streaming ownership instead.
6. Run focused stream/static, update-plan, structured-headless, stream-resumption, max-token, trajectory and free pty checks; then typecheck, full tests, build, diff checks, Trellis validation and independent review.

## Risk and rollback points

- Preserve post-redaction structured output: consume `modelMessageEvent`, not raw deltas.
- Preserve exact stream-interruption continuation and max-token partial handling.
- Ensure `turnEnded` finalizes the live checklist exactly once after direct events.
- Verify historical v1 trajectory records tolerate the removed optional field.
- Do not touch user image files or unrelated ahead-of-origin commits.

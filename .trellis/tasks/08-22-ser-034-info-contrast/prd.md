# SER-034 informational transcript contrast

## Goal

Make durable informational transcript entries readable at normal terminal intensity while retaining Darwin's shared semantic visual language and every existing transcript/frame contract.

## Confirmed repository evidence

- `MessageList` renders every finished notice through one `<Static>`-owned `HistoryEntry`; `info` currently gives the marker and body the same gray foreground plus `dimColor`.
- `visual-language.ts` is the shared semantic vocabulary. `/memory`, `/mcp`, `/status`, `/help`, and other local reports all dispatch ordinary informational notices rather than selecting presentation themselves.
- Stable text markers, optional color, exact report bytes, and unchanged row ownership are established by `.trellis/spec/frontend/live-frame.md` and `.trellis/spec/frontend/tui-testing.md`.
- Research run `2026-08-22T06:37:01Z` ranks this shared-renderer presentation fix as SER-034; the Host has already changed only its backlog status to `in-progress`.

## Requirements

- Render the durable `info ·` marker with a clear shared semantic accent.
- Render informational notice/report body text at normal terminal intensity, without dim SGR.
- Apply the behavior in the common notice renderer, with no command-specific styling, so it covers `/memory`, `/mcp`, `/status`, `/help`, and every other informational notice.
- Preserve informational report text byte-for-byte after ANSI stripping, including marker spacing and multiline bodies.
- Preserve warning/error marker and color hierarchy, `<Static>` ownership, margins, row/frame behavior, and monochrome readability.
- Keep semantic color choices centralized in `visual-language.ts`; do not add dependencies, network/model calls, new rows, or formatter content changes.
- Update focused deterministic forced-color coverage and the executable frontend specification.
- Do not mark SER-034 `done`; Host acceptance owns the backlog transition and supervision log.

## Acceptance Criteria

- [x] Forced-color rendering gives `info ·` a distinct semantic accent while its body contains no dim SGR.
- [x] Warning and error entries retain distinct textual markers and semantic colors.
- [x] ANSI-stripped informational output is exactly `info · ` followed by the unchanged report text.
- [x] One shared renderer covers simple and multiline informational notices without formatter-specific branches.
- [x] Finished notices remain in `MessageList` history under `<Static>` with unchanged geometry.
- [x] Focused visual-language and command formatter suites pass; free pty completion and MCP scenarios pass if exercised.
- [x] `pnpm typecheck` and one final full `pnpm test` pass after source settles.

## Out of scope

- Rewording or reformatting any command/report.
- Changing warning/error content, adding startup animation (SER-035), or introducing new transcript/frame surfaces.
- Updating SER-034 from `in-progress` to `done` or editing prior research claims.

# Darwin self-evolution backlog — priorities 121–140

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-089 — Route bracketed paste to the active history or rewind search owner before the composer: filter through existing bounded query updates, never mutate or submit the underlying draft, and retain permission/compaction ownership

- Status: `in-progress`
- Priority: 121
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-13.md`](../research_2026-09-13.md) (run `06:21:23Z`)

### Implementation / acceptance evidence

Not implemented. Real CLI pty at `75e40ae`: Ctrl+R plus bracketed NEEDLE leaves query `(all)` and changes DRAFT to DRAFTNEEDLE; Escape discards NEEDLE. `/rewind` plus MISSING changes the draft while leaving both checkpoint matches. Probe task `bg-ec3d17d4-31ad-418b-8d19-9086391148bf` exited 0; origin report records artifacts. Acceptance: offline real CLI pty with private HOME/project and local SDK fixture, both search modes, single-line/multiline/Unicode/over-cap/repeated and same-event paste; pasted text filters the query with unchanged underlying draft/cursor, no automatic submission/branch/queue/model request, Enter/Tab retains explicit acceptance, Escape restores exact original. Permission and compaction still ignore paste; ordinary composer paste still edits without sending. Query remains under existing 256-code-point cap; normalized line endings and safe counted rows; durable history/checkpoints unchanged by filter/cancel. Run focused search/frame/composer checks, free `verify-tui.ts historySearch` and `rewind`, full typecheck/test/build. Record independent Host evidence before done.

### Notes / blockers / abandonment reason

Depends on SER-088: multiline query presentation must be safe before paste is routed to it. Sources R4–R6 in origin run; `App.usePaste` ignores search refs, while `useInput` routes rewind then history. Installed Ink explicitly separates paste from keyboard channels. Reuse `normalizeDraftText`, immediate search refs and existing query transitions; do not synthesize Enter/Tab or broaden keyboard semantics. No dependency, new key/row/timer/store, SDK loop, runtime or permission policy change. Host owns research/backlog/log; developer child owns focused implementation/tests and necessary EN/zh-CN docs, independently accepted before closure.


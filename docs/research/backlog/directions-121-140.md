# Darwin self-evolution backlog — priorities 121–140

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-089 — Route bracketed paste to the active history or rewind search owner before the composer: filter through existing bounded query updates, never mutate or submit the underlying draft, and retain permission/compaction ownership

- Status: `done`
- Priority: 121
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-13.md`](../research_2026-09-13.md) (run `06:21:23Z`)

### Implementation / acceptance evidence

Accepted `63e8cc0` (`fix(tui): route paste to the active search owner`), fresh child `session-20260913-065841818`, task `bg-622f8525-9e8b-449d-9816-db2bfbb33c0e` exit 0, fully drained. Ten production lines in `App.usePaste` route normalized text through immediate rewind/history refs and existing bounded updates, leaving permission/compaction guard and composer fallback unchanged. Host reviewed all 8 changed files and ran `pnpm typecheck && pnpm test && AWS_EC2_METADATA_DISABLED=true pnpm tsx spike/verify-tui.ts historySearch && AWS_EC2_METADATA_DISABLED=true pnpm tsx spike/verify-tui.ts rewind && pnpm build && git diff --check && git status --short`, task `bg-c279a3d3-b5b2-4bae-a1a0-baa4772400f8`, exit 0. Full gate 8,599 PASS lines includes new registered search-paste26, history-search161, rewind-search157, frame-budget80 and composer coverage; extra historySearch12/rewind9. New suite uses private HOME/cwd, real CLI/SDK local transport, exact 256-code-point cap, Unicode/multiline/control/repeated/same-write paste, exact cancellation cursors, no filter-time durable bytes/model requests, explicit Enter/Tab acceptance, permission/compaction blocking and bounded frames. EN/zh-CN narrative/reference and architecture synced; README still accurate, AGENTS untouched. Clean tree, dist rebuilt. Log `/tmp/darwin-ser089-host-acceptance.log`; iteration-log Batch 132.

### Notes / blockers / abandonment reason

Depends on SER-088: multiline query presentation must be safe before paste is routed to it. Sources R4–R6 in origin run; `App.usePaste` ignores search refs, while `useInput` routes rewind then history. Installed Ink explicitly separates paste from keyboard channels. Reuse `normalizeDraftText`, immediate search refs and existing query transitions; do not synthesize Enter/Tab or broaden keyboard semantics. No dependency, new key/row/timer/store, SDK loop, runtime or permission policy change. Host owns research/backlog/log; developer child owns focused implementation/tests and necessary EN/zh-CN docs, independently accepted before closure.


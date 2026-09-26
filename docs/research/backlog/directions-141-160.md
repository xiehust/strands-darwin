# Darwin self-evolution backlog — priorities 141–160

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-102 — Extend `/review` with an explicit full-SHA commit scope while preserving existing current-change and literal-focus forms

- Status: `done`
- Priority: 141
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-26.md`](../research_2026-09-26.md) (run `03:44:50Z`)

### Implementation / acceptance evidence

Accepted commit `3ec0da4f139793dd3477d3100a03ee52b3c11dee` (`feat(review): support exact commit review scope`). Child session `session-20260926-040422866` ran in managed task `bg-657cc00a-c095-4bb1-a273-c57bfc9ada2e` (exit 0, drained); prior attempt `bg-dc7bacb3-3df5-4c90-bbc9-b866033abeee` stopped before its first model call when Host set `AWS_EC2_METADATA_DISABLED=true`, preventing Bedrock token minting. Initial malformed launch `bg-83849d9e-fd03-408c-a757-166ff5dcfda7` failed CLI `-p` grammar before a session existed. Host inspected command, runtime, TUI, headless and REPL integration diff, focused suite changes and EN/zh-CN README, guide/reference and architecture text. Host reran `pnpm typecheck && pnpm test && AWS_EC2_METADATA_DISABLED=true pnpm tsx spike/verify-tui.ts completion && pnpm build && git diff --check && git status --short` in `bg-31a8c4b6-76bb-46d4-9002-dfba02317254` (exit 0; 9,756 `PASS` lines, zero failure sections, completion 75/0; clean tree, built dist). Existing `/review` focus unchanged, malformed explicit commit refused locally and no model turn; no live-provider review-quality claim. Iteration log: Batch 152. Child usage input unknown (`-` from stopped attempt), output 18,221, cacheRead unknown, cacheWrite unknown; successful task alone input 92, output 18,221, cacheRead 3,691,767, cacheWrite 120,506. Cost aggregate unknown; successful task $1.2220.

### Notes / blockers / abandonment reason

Implement an explicit `/review --commit <40-hex-SHA>` target; retain exact legacy `/review` and `/review <focus>` prompt bytes and parsing behavior except malformed `--commit` invocations, which must give local usage without a model turn. A valid invocation should produce a fixed review-only prompt naming the exact SHA, guiding inspection of the target commit diff against its parent (root commits against empty tree), surrounding code and relevant tests; unsupported/missing git objects must be reported rather than fabricated. No shell interpolation, hidden git execution or new reviewer executor at parse time; ordinary SDK invocation, gate, prompt queue, literal input trajectory and no-edit guidance stay intact. Explicit SHA avoids rev/flag injection and moving refs. Document grammar in README and user guide/reference EN/zh-CN and rationale in architecture only if changed. Extend review tests across parser, runtime/headless, TUI/REPL, invalid local path and permission behavior; run typecheck, test, free TUI completion and build. Host owns report/backlog/iteration log, child owns implementation/docs and may commit them. No score exception or product decision needed.


## SER-103 — List local Darwin session processes with a read-only `/list-agents` projection of existing leases

- Status: `done`
- Priority: 142
- Score: 14
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 3
- Risk: 3
- Origin report: [`research_2026-09-26.md`](../research_2026-09-26.md) (run `05:11:10Z`)

### Implementation / acceptance evidence

Accepted 2026-09-26 at `8d588e242d188d8cb1b3b6ded5e3ea9f05679017`, incorporating feature commit `947513b5f4f4e94fe6a5fc56df511842f1bfab3b`. Child session `session-20260926-052906558`; see `docs/iteration-log.md` Batch 153. Host inspected both diffs, source/CLI/TUI wiring, bilingual docs and byte-identical extracted lease helper bodies. First full gate passed but actual-HOME smoke failed product acceptance: 1,296 historical project directories crowded the current project's live lease out of the first 128. Same-child focused correction prioritizes current canonical project (and explicit current TUI session) within unchanged budgets, without duplicate reads. Second Host acceptance (`bg-97073123-5491-47c2-b7bb-8d5637af332e`, exit 0): `pnpm tsx spike/verify-list-agents.ts`, `pnpm tsx spike/verify-list-agents-pty.ts`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `node dist/spike/verify-list-agents.js`, built-CLI live-HOME assertion finding Host session `session-20260926-050636115`, `git diff --check`, clean tree. First Host gate (`bg-888c5d76-5db2-4340-9a4e-39294d4eb2f0`) independently passed free `spike/verify-tui.ts completion` (75/0); correction did not change command discovery. Real fixtures verify snapshotless cross-project leases, invalid/dead/foreign/oversized/symlink/FIFO/EACCES exclusions, shared bounds/omissions, terminal sanitization, immutable state hashes, provider/SDK/config/network tripwires and idle/busy no-extra-turn behavior. No live model quality assertion.

### Notes / blockers / abandonment reason

User explicitly requested `/list-agents` to see local Darwin processes. Implement a bounded read-only user command across the current user's existing `~/.darwin/sessions/<project-key>/<session-id>/lease.json` state, reusing lease liveness semantics without creating a second registry or changing leases. Show PID, session ID, project key (not a falsely reconstructed cwd), start time and current process marker. Describe scope honestly as live local session lease holders in this HOME, not all OS processes: older/non-registering processes, other users/homes/hosts and SDK subagents without a separate process are outside it; PID liveness is not authenticated process identity. Add `darwin list-agents` local CLI sibling for scripting and headless no-model inspection. `/agents` and `darwin sessions` retain their existing meanings. No messaging, socket, signals other than signal 0, launch/cancel, transcript reads, background polling, model tool or SDK-loop change. Centralize paths; sanitize terminal data; fail closed on unsafe entries and state omissions. EN/zh-CN README/task guide/reference and architecture explanation required; AGENTS.md is already at the byte cap, do not grow it. This is the prerequisite for SER-104, not an implicit messaging authorization.

## SER-104 — Add explicitly authorized local cross-session text messaging without sharing permissions or conversations

- Status: `not-started`
- Priority: 143
- Score: 9
- Importance: 5
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 5
- Risk: 5
- Origin report: [`research_2026-09-26.md`](../research_2026-09-26.md) (run `05:11:10Z`)

### Implementation / acceptance evidence

Not implemented. Source: Claude Code cross-session messaging S1 documents local sockets, independent `ListAgents`/`SendMessage`, receiving-session permission checks and accept/hold/refuse controls. Darwin decisions doc §§ Permissions, Direct driver streaming, The prompt queue, Session trajectory, Subagents define the constraints. SER-103 supplies human discoverability only, not an authenticated endpoint.

### Notes / blockers / abandonment reason

Depends on accepted SER-103. Before implementation, user must choose recipient authorization and scope: recommended explicit session-local opt-in, same canonical project by default, incoming text held for user acceptance before any model turn, no automatic replies; cross-project communication only if separately authorized. Alternative unattended peer collaboration requires explicit auto-delivery/turn-budget/loop policy and headless behavior. The request establishes interest in communication but does not resolve these cost and cross-session authorization choices. Do not infer that same OS user, process visibility, yolo mode or sender approval authorizes the recipient. Once decided, design bounded local transport and authenticated process/session identity, send/receive provenance, literal text (no slash/`!`/`@` expansion), recipient's ordinary tool gate, no prompt/approval/config mutation, no delegated permission bypass, no sender history/files, next-idle-turn delivery only, cancellation/shutdown/clear/rewind and replay evidence. No cloud, arbitrary host access, shared filesystem write scheduling, autonomous swarm or replacement SDK loop. Independent acceptance must use two real processes plus hostile sender/spoofing, denied permission, queue/expiry/backpressure, self-loop and lifecycle negative controls. Until user decides, preserve `not-started` and halt the batch at this direction under section 7; do not reinterpret it as a harmless notification-only substitute.

2026-09-26 Host selection after SER-103 acceptance: prerequisite is now shipped at `8d588e2`, Score remains 9 (passes the gate), and the remaining premise is not falsified. Halt condition **only the user can decide**. No child launched for SER-104 and no recipient/transport code added. Ask whether to authorize same-project, session-opt-in, per-message human acceptance (recommended), or unattended automatic delivery; also ask whether cross-project sessions may communicate. Resume this batch after that answer, rather than performing fresh research.


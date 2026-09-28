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

- Status: `done`
- Priority: 143
- Score: 9
- Importance: 5
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 5
- Risk: 5
- Origin report: [`research_2026-09-26.md`](../research_2026-09-26.md) (run `05:11:10Z`)

### Implementation / acceptance evidence

Accepted 2026-09-26 at `452e0c5afaf7d7fb89a00889a0bbd420d8935d45`, incorporating `eb010f2f4e2e50b5092704bc6daecdaac209562f`. Fresh developer session `session-20260926-141121540`; three tasks (initial stream-idle failure, recovery, focused acceptance correction), recorded in `docs/iteration-log.md` Batch 154. Host inspected 39-file implementation and 15-file correction; first full gate passed but independent real-PTY/owned-HOME probes found post-failure auto-drain, stale registration prefix hiding live endpoints, invalid CLI grammar and incomplete headless peer failure results. Same-child correction accepted only after second Host gate `bg-23efa471-8bea-4d0e-870b-8393140f00e8` exit0: `pnpm tsx spike/verify-collaboration-failures.ts`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `node dist/spike/verify-collaboration-failures.js`, `node dist/spike/verify-collaboration.js`, `node dist/spike/verify-collaboration-drivers.js`, diff check and clean tree. First Host free completion passed75/0; correction retained command catalogue/help. Real-process suites prove automatic same-project bidirectionality, actual one-time user CLI confirmation, symmetric durable pair reuse after both processes restart, revoke/regrant fencing, private/corrupt/concurrent/symlink storage, hostile IPC/identity/queue/loop controls, TUI idle/busy/failure and text/JSON/stream-JSON headless behavior, non-user trajectory/recall/rewind/memory provenance, plan and policy protections. No live-model collaboration quality assertion. State is `~/.darwin/collaboration/policy.json`; user commands `/collaborate` and `darwin collaborate`; parent-only `peer_discover`/`peer_send`. POSIX local only; Hub remains a versioned address/transport design seam. Both READMEs, bilingual task/reference/permission guides and architecture updated; AGENTS.md remains32767 bytes. Real HOME remains mode775, so live activation requires owner-approved permissions repair; no real trust grant/permission change performed. This environmental prerequisite does not invalidate private-HOME source/built acceptance.

### Notes / blockers / abandonment reason

Depends on accepted SER-103. Before implementation, user must choose recipient authorization and scope: recommended explicit session-local opt-in, same canonical project by default, incoming text held for user acceptance before any model turn, no automatic replies; cross-project communication only if separately authorized. Alternative unattended peer collaboration requires explicit auto-delivery/turn-budget/loop policy and headless behavior. The request establishes interest in communication but does not resolve these cost and cross-session authorization choices. Do not infer that same OS user, process visibility, yolo mode or sender approval authorizes the recipient. Once decided, design bounded local transport and authenticated process/session identity, send/receive provenance, literal text (no slash/`!`/`@` expansion), recipient's ordinary tool gate, no prompt/approval/config mutation, no delegated permission bypass, no sender history/files, next-idle-turn delivery only, cancellation/shutdown/clear/rewind and replay evidence. No cloud, arbitrary host access, shared filesystem write scheduling, autonomous swarm or replacement SDK loop. Independent acceptance must use two real processes plus hostile sender/spoofing, denied permission, queue/expiry/backpressure, self-loop and lifecycle negative controls. Until user decides, preserve `not-started` and halt the batch at this direction under section 7; do not reinterpret it as a harmless notification-only substitute.

2026-09-26 Host selection after SER-103 acceptance: prerequisite is now shipped at `8d588e2`, Score remains 9 (passes the gate), and the remaining premise is not falsified. The initial run halted for recipient policy; that historical recommendation above is superseded by the user decision below, not a new research direction.

User decision, 2026-09-26: “如果是同项目内，自动支持双向协作，无需额外同意。如果是本机内跨项目协作，可以首次有一次协作允许确认，并把确定后的协作关系记录到~/.darwin/目录下的某个文件中，下次重启darwin无需再确认了。设计时保留一个跨机协作（本次不现实，可能通过HUB的方式实现）”. Same canonical project: automatic bidirectional messaging, no additional cooperation approval. Local cross-project: one explicit human confirmation establishes a symmetric durable project-pair relation under the user-global `.darwin` directory, surviving fresh process/session ids. The confirmation must show both canonical projects and persistence; no implicit or model-issued trust grants. User-only list/revoke/disable controls required; revocation checked on both new send and queued delivery. Persist keys by canonical project identity, never PID/session id or lossy display labels. Future cross-machine collaboration is design-only: versioned address/envelope and a narrow local transport seam that can later use a Hub, no remote listener/cloud/Hub implementation now.

Implementation authorization: this is the continuation of SER-104 at unchanged Score9, no fresh research. Parent-runtime ordinary discovery/send tools and local user collaboration controls; keep SDK children isolated (no recursive peer tool catalogue), existing `/agents` semantics and read-only `list-agents` intact. Discovery distinguishes live lease-only sessions from messaging-capable endpoints and supplies exact unambiguous target identity. Local same-user IPC endpoints must bind sender project/session to actual registered endpoint identity, not trust arbitrary frame claims or PID alone; document the same-OS-user trust boundary honestly. No prompt/approval/config changes from peer text, no slash/shell/path expansion, receiving ordinary tools still pass the gate, never a new SDK loop or mid-turn injection. Do not use a peer to bypass a denied operation. Use an explicit non-user peer origin for trajectory/replay/recall/rewind/memory consent and visible sender attribution; an incoming message is not a user statement. Bounded message/queue/ack/expiry, causal auto-reply chain limits and cancellation/clear/rewind/shutdown cleanup must prevent spam, loops, stale endpoint reuse and silent loss. Headless should support messages only while its normal run is alive and drain admitted pending messages without becoming an endless idle daemon; unknown cross-project trust cannot be auto-approved in yolo/headless. Trust persistence must be atomic, owner-private, bounded and corruption/symlink/race-safe, with existing sensitive-path protections; model tools never grant/revoke trust. No changes to actual global user policy during development: use owned temporary HOME fixtures only.

Acceptance: real two-process same-project automatic bidirectional exchange; different-project denied/pending before one human approval, automatic reverse direction afterward, durable pair reuse after both restart, revoke-before-delivery, corruption/concurrent save/symlink/spoofed identity and stale endpoint negative controls. Real TUI busy/idle and headless delivery, no extra approval for same-project, no extra approval after durable cross-project grant, ordinary recipient permissions still enforced, literal hostile messages cannot execute `/`/`!`/`@` or become user consent. Prove bounded floods/causal loops, clear/rewind/cancel/shutdown behavior and distinct replay provenance; verify source and built CLI, full typecheck/test plus affected listed checks and completion, bilingual README/task guide/reference/architecture. Child must document exact implemented grammar/file path/caps and requirement-to-test mapping. Host owns backlog/research/log; implementation only through fresh developer worker (not SER-103's child).


## SER-105 — Jump to the start or end of a whole multiline composer draft with Ctrl+Home / Ctrl+End

- Status: `not-started`
- Priority: 144
- Score: 10
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 2
- Risk: 3
- Origin report: [`research_2026-09-28.md`](../research_2026-09-28.md) (run `14:45:24Z`)

### Implementation / acceptance evidence

Not yet implemented. Independently verify modified and unmodified Home/End against a real Ink/PTY composer in both wide and narrow multiline drafts; assert exact raw draft and cursor offsets, no submission, and no interference with completion/search/permission owners. Run focused input-control and free TUI suites, `pnpm typecheck`, `pnpm test`, `pnpm build`, and check documentation parity.

### Notes / blockers / abandonment reason

`src/tui/App.tsx` presently sends all `key.home || key.end` to `moveToRowEdge`; `src/tui/prompt-editor.ts` defines that operation on one visual row. Keep unmodified Home/End and Ctrl+A/E row-scoped, preserve the current editor's raw text/affinity and frame-budget invariants, and route *only* Ctrl+Home/End to absolute start/end after higher-priority keyboard owners. Installed Ink's `parseKeypress` recognizes CSI `1;5H` and `1;5F` as `home/end` with `ctrl: true` (local offline probe, 2026-09-28); the change uses that verified signal, no parser patch or new dependency. Document the chord in both READMEs and the EN/zh-CN user guide/reference; keep architecture rationale in its existing prompt-editor or frame-budget section if warranted. Host owns the backlog/research/iteration log; child owns implementation, tests, user docs, and the implementation commit.


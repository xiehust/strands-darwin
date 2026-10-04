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

- Status: `done`
- Priority: 144
- Score: 10
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 2
- Risk: 3
- Origin report: [`research_2026-09-28.md`](../research_2026-09-28.md) (run `14:45:24Z`)

### Implementation / acceptance evidence

Accepted implementation commit `560387d1bece58b3ff711cadf9eb6e9bb580655c` (`feat(tui): jump to whole draft with modified home and end`), fresh developer session `session-20260928-150625553`, managed task `bg-ef2af11a-e024-4f74-b077-85ef4b97c2ea` (exit 0, output drained). Host inspected the only child commit against explicit base `94681a2943662eb503263f15a564ef5194dea10b`, reviewed code, real PTY tests, EN/zh-CN README, guide and reference diffs, and reran `pnpm tsx spike/verify-composer-edges-pty.ts` (7/0), `pnpm tsx spike/verify-prompt-editor.ts` (63/0), free `pnpm tsx spike/verify-tui.ts completion` (76/0), `pnpm typecheck && pnpm test && pnpm build && git diff --check && git status --short` (exit 0; clean tree) in `bg-46c018c5-ad4d-4920-bec0-d4a120044552` and `bg-8b4c3237-a84d-4bdf-8718-1ba9b6f1b6bd`. Real PTY assertions include 70/24-column multiline and soft wraps, exact insertion witnesses, unchanged row-local keys, keyboard owners, and no unintended model calls. No live-provider quality claim. The extra, non-gate `spike/verify-tui.ts pathCompletion` scenario failed one hidden-row omission-notice assertion (26/1) in the child and the Host; selection/acceptance assertions passed. This failure was not resolved or claimed green; the scenario does not send Home/End, and the child diff did not touch completion rendering or its assertion. A baseline reproduction at the old SHA was not run. See `docs/iteration-log.md` Batch 155. One child task reported input 152, output 21,985, cacheRead 6,334,155, cacheWrite 124,191 tokens; approximate cost $1.7975.

### Notes / blockers / abandonment reason

`src/tui/App.tsx` presently sends all `key.home || key.end` to `moveToRowEdge`; `src/tui/prompt-editor.ts` defines that operation on one visual row. Keep unmodified Home/End and Ctrl+A/E row-scoped, preserve the current editor's raw text/affinity and frame-budget invariants, and route *only* Ctrl+Home/End to absolute start/end after higher-priority keyboard owners. Installed Ink's `parseKeypress` recognizes CSI `1;5H` and `1;5F` as `home/end` with `ctrl: true` (local offline probe, 2026-09-28); the change uses that verified signal, no parser patch or new dependency. Document the chord in both READMEs and the EN/zh-CN user guide/reference; keep architecture rationale in its existing prompt-editor or frame-budget section if warranted. Host owns the backlog/research/iteration log; child owns implementation, tests, user docs, and the implementation commit.



## SER-106 — Per-skill token cost rows in the on-demand `/context` breakdown: expand the aggregated skills-catalogue component into one bounded row per registered skill (name + `~N tokens` via the same one-`countTokens`-per-component rule; a failed count reads `not reported`; the total line and `/status` stay byte-identical)

- Status: `done`
- Priority: 145
- Score: 11
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-29.md`](../research_2026-09-29.md) (run `00:52:20Z`)

### Implementation / acceptance evidence

Accepted 2026-09-29: inherited implementation was preserved without losing dirty work at `581539518adba3ba4b11572bf95c160e92db52ea` (checkpoint, not independent acceptance); fresh supervised developer child `session-20260929-030601739` reviewed that checkpoint, added an offline real-SDK runtime fixture and EN/zh-CN README, task-guide, and reference explanations, and committed `12bd7063d89979ac5021f6399240afd95c8c97fb`. Host independently inspected both commits and the changed source, suite and docs; re-ran `pnpm tsx spike/verify-context-skills.ts` (26/0), `pnpm typecheck`, `pnpm test`, `pnpm build`, `git diff --check`, and a clean-tree check (all exit 0; full gate `bg-d666a3cd-1587-485f-be36-0aa6507fda66`). The total and `/status` remain unchanged, rows come from the injected catalogue with one count each, failures read `not reported`, and skill rows are bounded. Full supervision record: `docs/iteration-log.md`, Batch 156.

### Notes / blockers / abandonment reason

Peer source: Claude Code `/skill-doctor` shows each skill's context cost (research report S1, `code.claude.com/docs/en/whats-new`, accessed 2026-09-29). Darwin evidence: `src/agent/context-breakdown.ts` (SER-077) counts the skills catalogue as one aggregated component, so a heavy skill hides in the total. Extension points: the existing on-demand `/context` breakdown machinery and its bounded-row/`not reported` conventions (`src/tui/context-format.ts`, `MAX_STATUS_NAMES`-style bounds). Acceptance: `pnpm typecheck` + `pnpm test`; a focused free suite proving per-skill rows render under `/context`, a failed per-skill count reads `not reported`, and the total line + `/status` are byte-identical; re-run free `tui completion` if slash commands are touched; docs in EN/zh-CN README and user guide/reference. Host owns backlog/research/iteration log; child owns implementation, tests, user docs, and the implementation commit.

## SER-107 — Interactive OAuth login for remote MCP servers: a bounded authorization-code + PKCE `OAuthClientProvider` (localhost loopback callback, per-server token store under `~/.darwin/mcp-auth/`) wired through the SDK's existing `authProvider` slot, with a login command and 401-driven guidance; static `auth` client-credentials pass-through documented

- Status: `done`
- Priority: 146
- Score: 6
- Importance: 3
- Architecture fit: 3
- Evidence confidence: 4
- Difficulty: 4
- Risk: 3
- Origin report: [`research_2026-09-29.md`](../research_2026-09-29.md) (run `00:52:20Z`)

### Implementation / acceptance evidence

Accepted 2026-09-29 after one focused correction. Fresh supervised developer child `session-20260929-040735579` implemented SDK `OAuthClientProvider`-backed authorization-code/PKCE login, per-server private credential store, loopback callback, CLI login/logout, held-project trust gate, OAuth-only `/mcp` 401 guidance and EN/zh-CN docs in `981413d82af5fab3b34dea23bebb13465486895b`. Host independently reproduced a logout/old-session refresh resurrecting a token and a symlinked `mcp-auth` directory redirecting a write; the same child corrected both in `dc7b40f5cf662d7caff8538ffc49efa0b66e4af3` with regression tests. Host inspected explicit base-to-HEAD changes, re-ran `pnpm tsx spike/verify-mcp-oauth.ts` (262/0), then `pnpm typecheck`, `pnpm test`, `pnpm build`, diff and clean-tree checks (all exit 0; full gate `bg-13c6b7e8-7cbc-48d8-9339-1c81c2c772c4`). `/mcp` remains a read-only projection; static client-credentials pass-through is retained. Supervision record: `docs/iteration-log.md`, Batch 157.

### Notes / blockers / abandonment reason

Peer sources: Claude Code `claude mcp login` (S1); Gemini CLI MCP OAuth with SSRF prevention in discovery and server filtering under restricted modes (S9 — apply the same discovery-endpoint validation). Darwin evidence: the SDK exposes `authProvider?: OAuthClientProvider` and client-credentials `auth` (`node_modules/@strands-agents/sdk/dist/src/mcp/client.d.ts`); `src/mcp/registry.ts` delegates config parsing to `McpClient.loadServers()` and has no OAuth (grep). Constraints: token store is new darwin-owned state — bounded, per-server, never logged, never in trajectory or `/mcp` output (the read-only-projection contract stands); untrusted-project `held` semantics (SER-090) must gate any login attempt for project-declared servers; no new dependency if the MCP SDK's own auth helpers suffice. Acceptance: `pnpm typecheck` + `pnpm test`; focused free suites against a local fake OAuth server (loopback only, no network) proving login → token store → authenticated connect, token reuse across restarts, refresh, and refusal paths; no real provider credentials in tests; docs in EN/zh-CN README and user guide/reference. Host owns backlog/research/iteration log; child owns implementation, tests, user docs, and the implementation commit.

## SER-108 — `/goal <condition>` condition-checked self-continuation: after a turn ends, one bounded condition check evaluates the goal; unmet → exactly one auto-submitted continuation prompt through the ordinary `submit()` path; hard cap on consecutive auto-continuations, visible live state, `/goal` bare/off forms; permission prompts and user cancel always win

- Status: `done`
- Priority: 147
- Score: 6
- Importance: 3
- Architecture fit: 3
- Evidence confidence: 4
- Difficulty: 3
- Risk: 4
- Origin report: [`research_2026-09-29.md`](../research_2026-09-29.md) (run `00:52:20Z`)

### Implementation / acceptance evidence

Accepted 2026-09-29: fresh supervised child `session-20260929-053258085` committed `1842df4695edd4e896352fbef81d6790a5580954`. Interactive `/goal` uses one bounded classifier-tier condition check after completed turns, a five-continuation cap, ordinary `submit()` with queue/task/peer and permission precedence, cancel-wins, and existing header/busy rows. Bare/off/clear and headless refusal are explicit; EN/zh-CN docs and architecture rationale are synced. Host independently reviewed the diff, re-ran `spike/verify-goal-command.ts` (81/0), free `spike/verify-tui.ts goal` (45/0), `completion` (81/0), and final `pnpm typecheck`, `pnpm test`, `pnpm build`, diff and clean-tree checks (all exit 0; full gate `bg-4676332e-4da6-480b-b678-bcbb921af246`). The first Host gate timed out in the existing review fixture; `spike/verify-review-drivers.ts` then passed alone (17/0), and the complete gate passed on the subsequent run. The failed attempt remains recorded in `docs/iteration-log.md`, Batch 158.

### Notes / blockers / abandonment reason

Peer source: Claude Code `/goal <condition>` — a fast model checks after each turn whether the condition holds; if not, another turn starts automatically; works interactive and in `-p` (S1, Claude Code what's-new 2026-w20, accessed 2026-09-29). Darwin evidence: `src/tui/prompt-queue.ts` drains one queued prompt per idle through the ordinary `submit()` path — the seam a goal continuation must reuse; nothing today restarts a turn from an unmet condition. Risk is the point of the requirement: autonomous turns spend tokens unsupervised, so the hard cap, visible live state (existing busy/live rows, no new frame surface), cancel-wins and permission-gate precedence are load-bearing, and the condition check itself must be bounded and observable. Interactions to pin down in implementation: `/clear` drops the goal; prompt queue and `!` drain ordering unchanged; headless behaviour explicit (either supported with the same cap or refused with a notice — child's evidence decides, stated in docs). Acceptance: `pnpm typecheck` + `pnpm test`; a free pty scenario proving cap enforcement, cancel-wins, queue interaction and visible state; docs in EN/zh-CN README and user guide/reference. Host owns backlog/research/iteration log; child owns implementation, tests, user docs, and the implementation commit.

## SER-109 — Process environments are sensitive reads: `/proc/<pid>/environ` (any pid token — digits, `self`, `$PPID`/`${PPID}`/other `$VAR`, globs such as `*`, and the `/proc/<pid>/task/<tid>/environ` form) joins the SER-071 sensitive set in `sensitiveReadPath`, so `fileEditor view` and whitelisted bash readers on it become `dangerous`, are prompted even in `plan`, are denied in headless and get no allow-rule — closing the unprompted bypass of SER-082's shell-env scrub

- Status: `done`
- Priority: 148
- Score: 15
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 3
- Origin report: [`research_2026-10-03.md`](../research_2026-10-03.md) (run `13:23:35Z`)

### Implementation / acceptance evidence

Accepted 2026-10-03 in `084fb111279a494024fc9484cc68c666bebef103` (`fix(permission): treat /proc/<pid>/environ as a sensitive read`, 7 files). The fresh supervised child was `session-20261003-134952588`, task `bg-5fe318c6-270b-4916-8ff0-e42cb8efdad0`, exit 0, drained.

What changed: `src/agent/permission-rules.ts` adds `isProcessEnvironPath` (any single pid segment, plus the `task/<tid>` form; `proc`/`environ` segments matched as bash glob words via `globMayMatch`, with `$` counting as a possible match) inside the shared `isSensitiveReadPath`. `sensitiveLocationBelow` gains the `/proc`, `/proc/<pid>`, `/proc/<pid>/task` and `/proc/<pid>/task/<tid>` ancestors for recursive `grep`/`rg`. `/proc/sys` and the other non-pid segments are excluded. There is no second classifier.

Host acceptance:
- `git log e030eb9..HEAD` showed only the child commit; Host read the source diff.
- The original research probe (`/tmp/ser-probe/probe*.ts`) re-ran at `084fb11`. `cat`/`head -c`/`grep -a` on `/proc/$PPID/environ`, `cat /proc/*/environ`, `/proc/1/environ`, `/proc/self/environ` and `fileEditor view /proc/12345/environ` all went from `safe` to `dangerous | reads a sensitive path: …`. `cat /proc/$PPID/cmdline` and `echo $ANTHROPIC_API_KEY` stay `safe | read-only command`, and the `strings`/`less`/`tr <`/`ps` reasons are unchanged.
- The new suite run against the base `permission-rules.ts` (separate worktree) fails at import, which proves the suite pins the new export.
- Host gate `bg-cfb17563-eb3b-4a10-8f04-9621a55d3613`, exit 0: `verify-permission-modes.ts` 379/0, `verify-permissions-command.ts` 42/0, `verify-deny-rules.ts` 95/0, `verify-permissions-test.ts` 83/0, then `pnpm typecheck && pnpm test` (`26 passed, 0 failed`) `&& pnpm build && git diff --check`, with a clean tree.
- Docs: the decisions doc has a SER-109 paragraph plus a correction to SER-082's `/proc/self/environ` sentence; `permissions`/`reference` EN and zh-CN are updated; README needed nothing; AGENTS.md is unchanged at 32,753 bytes.

### Notes / blockers / abandonment reason

Evidence (report R3/R4, offline `classify` + `assessRisk` probe at `dd79491`): `cat /proc/$PPID/environ`, `head -c 4000 /proc/$PPID/environ`, `grep -a KEY /proc/$PPID/environ`, `cat /proc/*/environ`, `cat /proc/1/environ` and `cat /proc/self/environ` all return `safe | read-only command`, and `fileEditor view /proc/12345/environ` returns `safe | fileEditor is read-only`. In this session's darwin process, the parent environ held 19 credential-shaped names (`ANTHROPIC_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `NPM_TOKEN`, …) that SER-082 withholds from the shell. One unprompted `cat` in `default`/`auto` mode puts every one of those values into the tool result, the trajectory and `/export`, which is exactly the leak SER-082 was built to stop (`docs/architecture/load-bearing-decisions.md`, SER-082 paragraph). Nothing in SER-071 or the decisions doc excludes `/proc` deliberately.

Extension point: `src/agent/permission-rules.ts` (`SENSITIVE_READ_*`, `sensitiveReadPath`), the one helper that `assessRisk` and `/permissions` already share. The matcher must cover how the bash classifier sees paths: literal `$PPID`/`${PPID}` tokens (the classifier does not expand variables), glob tokens, `self`/`thread-self`, `task/<tid>`, and relative paths that resolve under `/proc` (`cd /proc && cat 1/environ` is a cwd question; state what is and is not covered). It should stay narrow: `/proc/<pid>/cmdline`, `/proc/cpuinfo` and the like remain ordinary reads unless the child finds a recorded reason. Risk 3 comes from matcher coverage and from not regressing existing safe reads.

Acceptance: `pnpm typecheck` + `pnpm test`; the SER-071 suite (whichever `spike/verify-*.ts` covers `sensitiveReadPath`, extended) proving every probe command above is `dangerous` with a `reads a sensitive path` reason and 0 rules offered, while `cat /proc/cpuinfo`, `cat src/cli.ts` and `rg secret src/` keep their prior verdicts byte-identical; `verify-permissions-command.ts` and `verify-deny-rules.ts` stay green; the decisions doc paragraph for SER-071/SER-082 states the addition; AGENTS.md stays under 32 KiB.

Residual gaps, stated in the decisions doc and left for a fresh research run rather than reinterpreted into this direction:
- `cat 1/environ` after a `cd /proc` is not covered, because the classifier resolves against the project root and doesn't track the shell's cwd.
- A leading variable (`cat $D/1/environ`) is not covered.
- The child also reported possible SER-071 home-set escapes, which the Host verified at `084fb11` (`/tmp/ser-probe/probe3.ts`): `cat ~/".ssh"/id_rsa`, `cat ~/'.aws'/credentials` and `cat /proc/self/root/home/ubuntu/.ssh/id_rsa` are `safe | read-only command`. These are queued separately as SER-112 (same origin report, addendum).

## SER-110 — Keep git's paired env-config protocol intact through the shell-env scrub: `GIT_CONFIG_KEY_<n>` always survives (it carries a git config *name*; the paired `GIT_CONFIG_VALUE_<n>` and `GIT_CONFIG_COUNT` already pass), so an IDE- or CI-injected `GIT_CONFIG_COUNT` no longer makes every model-shell `git` call fail with `fatal: unable to parse command-line config`

- Status: `done`
- Priority: 149
- Score: 16
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 1
- Risk: 1
- Origin report: [`research_2026-10-03.md`](../research_2026-10-03.md) (run `13:23:35Z`)

### Implementation / acceptance evidence

Accepted 2026-10-03 in `581fee259a55480daa311e4e5ee3fcc1795e652f` (`fix(shell-env): keep git's GIT_CONFIG_KEY_<n> through the scrub (SER-110)`, 5 files). The fresh supervised child was `session-20261003-150015772`, task `bg-8987036e-371a-4e3a-b061-2e656418869b`, exit 0, drained.

What changed: `src/tools/shell-env.ts` adds `ALWAYS_SURVIVE_PATTERNS = [/^GIT_CONFIG_KEY_(?:0|[1-9][0-9]*)$/]`, which is anchored, case-sensitive, limited to git's canonical decimal index and unconditional on COUNT, and is checked in `alwaysSurvives`. The rule stays name-only and never inspects values. `FOO_KEY`, `GIT_TOKEN`, `GIT_ASKPASS_TOKEN`, `GIT_CONFIG_KEY_01` and `GIT_CONFIG_KEY_TOKEN` stay withheld.

Host acceptance:
- `git log aa45972..HEAD` showed only the child commit; Host read the source diff.
- Real-environment control (`/tmp/ser-probe/probe-git.mts`): this Host's actual darwin environ was fed in-process through `scrubShellEnv`, with values never printed, and `git rev-parse` was spawned under the result. Base `aa45972` withheld `GIT_CONFIG_KEY_0,GIT_CONFIG_KEY_1` (20 names) and git exited **128** with `fatal: unable to parse command-line config`. At `581fee2`, no git names were withheld (18) and git exited **0**.
- Host gate `bg-6812cab0-4397-4415-843e-291ac5f247ff`, exit 0: `verify-shell-env.ts` 79/0, `verify-status-command.ts` 109/0, `verify-config.ts` 422/0, then `pnpm typecheck && pnpm test` (`26 passed, 0 failed`) `&& pnpm build && git diff --check`, with a clean tree.
- Docs: the decisions doc has a SER-082 list edit plus a SER-110 paragraph with the secrecy argument; `configuration` EN and zh-CN are updated; READMEs and AGENTS.md were untouched (neither lists the set).

### Notes / blockers / abandonment reason

Evidence (report R1/R6): this session's darwin process inherited `GIT_CONFIG_COUNT=2`, `GIT_CONFIG_KEY_0=credential.interactive`, `GIT_CONFIG_KEY_1=credential.guiPrompt` and `GIT_CONFIG_VALUE_{0,1}=false` from the Orca IDE terminal. `CREDENTIAL_NAME_PATTERN` (`src/tools/shell-env.ts`) matches `KEY` in `GIT_CONFIG_KEY_<n>`, so the model shell gets COUNT and both VALUEs but no KEY, and every `git` command exits 128. git documents that "Any missing key or value is treated as an error" (https://git-scm.com/docs/git-config, accessed 2026-10-03). The user sees `2 credential-shaped variables withheld (GIT_CONFIG_KEY_0, GIT_CONFIG_KEY_1)` at startup, but nothing links that notice to the git failure; the documented workaround (`shellEnv.passthrough: ["GIT_CONFIG_KEY_*"]`) is undiscoverable from the error. Ordering: placed after SER-109 for safety, despite the one-point-higher score.

Extension point: `ALWAYS_SURVIVE_PREFIXES` or an equivalent stated rule in `src/tools/shell-env.ts`. The secrecy argument belongs in the decisions doc: keeping the KEY names exposes no value that is not already passed today, because the VALUE names never matched the pattern. Withholding credential-like VALUEs was rated separately and gated out (Score 5, report). The child may instead choose a whole-protocol coherence rule if it states why; it must never inspect values.

Acceptance: `pnpm typecheck` + `pnpm test`; `spike/verify-shell-env.ts` extended with the pure rule and a real foreground shell started with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=cat` in which `git config --get core.pager` prints `cat` and exits 0, plus an unrelated `FOO_KEY` still withheld; the startup notice and `/status` row drop the git names; decisions doc SER-082 paragraph updated.

## SER-111 — Tell the model its shell environment was scrubbed: when `RuntimeInfo.shellEnv.withheld` is non-empty, the `<working-context>` fragment gains one bounded line naming the count and up to a few withheld names (never a value), stating that those variables are unset in `bash` and that only the user can restore one via `shellEnv.passthrough`

- Status: `done`
- Priority: 150
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-10-03.md`](../research_2026-10-03.md) (run `13:23:35Z`)

### Implementation / acceptance evidence

Accepted 2026-10-04: existing production commit `100ad9237e5d9bb135d8998e0171da21cc8ed70f`, plus recovery child commit `60b89b613f00ab6f170305f5491966a15daba7f9`. Fresh developer recovery session `session-20261004-082921253`: initial managed task `bg-5b5842c6-a857-4c07-b0f5-ff6d347d7da0` exited 1 on a provider server error; same-session retry `bg-73a3de9e-1dd9-46ce-b027-32fd8cee999b` exited 0. Both outputs drained. Production audit found no defect; recovery added cache-placement, cloud-preference adoption/pre-model/removal and `/rewind` checks, replaced a `/proc` shell test with a synthetic child-shell absence assertion, and synced reference EN/zh-CN.

Host inspected explicit-SHA production/recovery diffs and independently ran `pnpm tsx spike/verify-working-context.ts` (84/0), `verify-shell-env.ts` (84/0), `verify-agentcore-memory.ts` (365/0), `verify-cli-args.ts` (43/0), then `pnpm typecheck && pnpm test` (26 groups passed, 0 failed), `pnpm build && git diff --check && git status --short`. Managed gate `bg-ab4bd0d6-ab60-4292-8a47-77dee2768e73` exited 0, tree clean, dist refreshed. Names-only value absence, empty-list byte identity, shared bounds, runtime refresh and successors verified offline. Configuration EN/zh-CN and decisions doc were already synced by `100ad92`; READMEs need no change. Supervision recorded in iteration-log Batch 161.

### Notes / blockers / abandonment reason

Evidence (report R5): the scrub is reported only to the user (startup notice, `/status` `shell env` row, headless `shell-env:` stderr; `docs/architecture/load-bearing-decisions.md` SER-082). `src/agent/working-context.ts` `buildWorkingContext` tells the model about tools and directory entries but not that its shell environment differs from the user's. In this research run, the model saw only `fatal: unable to parse command-line config`, and the sole route to a diagnosis was reading `/proc/$PPID/environ`, the very bypass SER-109 closes. Depends on SER-109: naming withheld variables to the model must not invite a `/proc` follow-up that still works.

Extension point: the existing `<working-context>` section (System prompt composition: fixed order, re-derived every run). The withheld set is computed once per `create()`, so the line is stable within a session and the prompt cache is unaffected. Bound it like `formatShellEnvNotice` (`MAX_NOTICE_NAMES`, `…`), reuse that wording source rather than adding a second formatter where possible, and add nothing when nothing was withheld. Children follow whatever working-context rule they already follow; state it.

Acceptance: `pnpm typecheck` + `pnpm test`; `spike/verify-working-context.ts` extended: the line is present with the right count and bounded names when withheld is non-empty, byte-identical output when it is empty, and no value ever appears (seed a value-bearing variable and assert its value is absent); decisions doc System-prompt/SER-082 paragraph updated.

## SER-112 — Sensitive-read paths are matched as bash will see them: quote removal (`~/".ssh"/id_rsa`, `~/'.aws'/credentials`) and the `/proc/<pid>/root/` and `/proc/<pid>/cwd/` re-rooting aliases no longer let a whitelisted reader or `fileEditor view` reach a SER-071 path behind a `safe` verdict

- Status: `in-progress`
- Priority: 151
- Score: 13
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 3
- Risk: 4
- Origin report: [`research_2026-10-03.md`](../research_2026-10-03.md) (run `13:23:35Z`, SER-109 acceptance addendum)

### Implementation / acceptance evidence

None yet.

### Notes / blockers / abandonment reason

Evidence: a Host probe at `084fb11` (`/tmp/ser-probe/probe3.ts`, offline `classify` + `assessRisk`) found that `cat ~/".ssh"/id_rsa`, `cat ~/'.aws'/credentials`, `cat /proc/self/root/home/ubuntu/.ssh/id_rsa` and `cat /proc/self/root/home/ubuntu/.darwin/config.json` all return `safe | read-only command`, while `cat ~/.ssh/id_rsa` is `dangerous | reads a sensitive path`. Bash removes the quotes, and `/proc/self/root` is the filesystem root, so each command reads the protected file without a prompt in `default`/`auto` mode. The SER-109 child surfaced this as out of scope, and it was not reinterpreted into SER-109.

Extension point: the same shared `sensitiveReadPath` in `src/agent/permission-rules.ts`. SER-109's `globMayMatch` already strips quotes per segment for the `/proc` match. This direction applies quote removal to the home/absolute/basename checks, and adds `/proc/<pid>/root/…` (strip the prefix, re-check the remainder as absolute) and `/proc/<pid>/cwd/…` (reached path unknowable → treat as sensitive when the remainder could name a sensitive basename or directory; the child decides and states the rule). Risk 4: this touches every path decision the gate makes, so the existing safe reads must stay byte-identical, including quoted ordinary paths (`cat "src/cli.ts"`).

Acceptance: `pnpm typecheck` + `pnpm test`; `spike/verify-permission-modes.ts` extended so that each probe command above (plus `fileEditor view /proc/self/root/etc/shadow`) is `dangerous` with a `reads a sensitive path` reason and 0 rules offered, while `cat "src/cli.ts"`, `cat '/etc/os-release'` and `ls /proc/self/root/tmp` keep their prior verdicts; `verify-permissions-command.ts`, `verify-deny-rules.ts` and `verify-permissions-test.ts` stay green; the decisions doc SER-071 material states the rule and any remaining gap.

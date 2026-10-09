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

- Status: `done`
- Priority: 151
- Score: 13
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 3
- Risk: 4
- Origin report: [`research_2026-10-03.md`](../research_2026-10-03.md) (run `13:23:35Z`, SER-109 acceptance addendum)

### Implementation / acceptance evidence

Accepted 2026-10-04 at `239cc3c06da94bb3dc660034b7628a6bafe26bdb` (`fix(permission): guard quoted paths and proc aliases`). Fresh developer child `session-20261004-093735129`; managed task `bg-faf57135-7aea-450a-8b7b-d63c878eed0e` exited 0, output drained, no retry/correction. Shared matcher strips embedded bash quotes/backslashes before expansion/normalization, re-roots leading proc root aliases and checks marked cwd tails without guessing their reached base; literal fileEditor syntax remains distinct. Risk, kind, un-ruleability, auto bypass, deny/plan order and child shared gate verified.

Host inspected the sole child commit and explicit-SHA seven-file diff. Offline before/after probe reproduced the original safe verdicts and then proved 10 sensitive calls dangerous with no offered/matching rule, plus 6 ordinary reads with exact unchanged safe reasons. No sensitive file or proc environment read. Independent gate `bg-fa215680-e2c0-4cb6-b94f-1b6ef844a94f`: `pnpm tsx spike/verify-permission-modes.ts` (1025/0), `verify-permissions-command.ts` (42/0), `verify-deny-rules.ts` (95/0), `verify-permissions-test.ts` (83/0), `verify-cli-args.ts` (43/0), then `pnpm typecheck && pnpm test` (26 groups passed, 0 failed), `pnpm build && git diff --check && git status --short`, exit 0 clean; dist refreshed.

Cwd rule: any normalized tail component naming a protected directory, fixed credential/policy basename, or `.env` variant is sensitive; bash variable/glob/brace segments conservatively match. Unmarked tails and bare cwd reads/searches retain their prior behavior. Decisions doc and permissions/reference EN/zh-CN state the rule and limits: persistent effective cwd, nonleading variable aliases, arbitrary symlinks, wrappers and quoted whitespace remain unresolved; `cwd/id_rsa` may miss when the unknown base is already `.ssh`. Not a sandbox. READMEs already state that boundary and needed no edit. Supervision recorded in iteration-log Batch 162.

### Notes / blockers / abandonment reason

Evidence: a Host probe at `084fb11` (`/tmp/ser-probe/probe3.ts`, offline `classify` + `assessRisk`) found that `cat ~/".ssh"/id_rsa`, `cat ~/'.aws'/credentials`, `cat /proc/self/root/home/ubuntu/.ssh/id_rsa` and `cat /proc/self/root/home/ubuntu/.darwin/config.json` all return `safe | read-only command`, while `cat ~/.ssh/id_rsa` is `dangerous | reads a sensitive path`. Bash removes the quotes, and `/proc/self/root` is the filesystem root, so each command reads the protected file without a prompt in `default`/`auto` mode. The SER-109 child surfaced this as out of scope, and it was not reinterpreted into SER-109.

Extension point: the same shared `sensitiveReadPath` in `src/agent/permission-rules.ts`. SER-109's `globMayMatch` already strips quotes per segment for the `/proc` match. This direction applies quote removal to the home/absolute/basename checks, and adds `/proc/<pid>/root/…` (strip the prefix, re-check the remainder as absolute) and `/proc/<pid>/cwd/…` (reached path unknowable → treat as sensitive when the remainder could name a sensitive basename or directory; the child decides and states the rule). Risk 4: this touches every path decision the gate makes, so the existing safe reads must stay byte-identical, including quoted ordinary paths (`cat "src/cli.ts"`).

Acceptance: `pnpm typecheck` + `pnpm test`; `spike/verify-permission-modes.ts` extended so that each probe command above (plus `fileEditor view /proc/self/root/etc/shadow`) is `dangerous` with a `reads a sensitive path` reason and 0 rules offered, while `cat "src/cli.ts"`, `cat '/etc/os-release'` and `ls /proc/self/root/tmp` keep their prior verdicts; `verify-permissions-command.ts`, `verify-deny-rules.ts` and `verify-permissions-test.ts` stay green; the decisions doc SER-071 material states the rule and any remaining gap.

## SER-113 — Compose an unsent prompt in the user's external editor with Ctrl+G, using Ink terminal suspension and bounded private temporary storage

- Status: `done`
- Priority: 152
- Score: 10
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 4
- Risk: 3
- Origin report: [`research_2026-10-05.md`](../research_2026-10-05.md) (run `12:58:57Z`)

### Implementation / acceptance evidence

Accepted commit `99b551a5b1701e6de8eaabd3d18dc0552f7ec1f7` (`feat(tui): edit the unsent draft in VISUAL/EDITOR with Ctrl+G`), from developer child `session-20261006-020034673`, base `9ec43ab22ac40a83989a21905820ede342ecb9b0`. `git log 9ec43ab..HEAD` showed only that commit. Host reviewed `src/tui/external-editor.ts` and the `App.tsx` integration: no-shell argv, VISUAL→EDITOR, Ink `suspendTerminal`, 0700/0600 private temp storage, caps refused rather than truncated, `O_NOFOLLOW` bounded strict-UTF-8 read, drain fence via `draining`, held Static history, and unmount reap.

Host re-ran:

- `pnpm typecheck && pnpm test` (`bg-a246ae5a-f06a-4484-b8e0-83776a8ce259`): exit 0, 144 suite summaries with 0 failed, including the new `verify-external-editor.ts` and `verify-external-editor-pty.ts`.
- An independent real-pty probe through the fixture CLI with real system programs as editors: 9/9 pass. `sed -i` changed a Unicode draft unsent, with no model call and no draft bytes under HOME; explicit Enter sent it exactly once; temp storage was removed; `VISUAL='true; touch …'` was refused and nothing ran; `false` kept the draft and an editable cursor.
- `pnpm build`: exit 0, `dist` refreshed.

Docs were synced by the child: both READMEs, `using-darwin{,.zh-CN}.md`, `reference{,.zh-CN}.md`, `/help`, and the decisions section "Ctrl+G external editor — a bounded terminal handoff, never a send path". AGENTS.md is unchanged at 32,762 bytes.

### Notes / blockers / abandonment reason

Sources: report S1 (Claude Code external-editor chord), S5 (OpenCode `/editor`), S7 (Aider editor composition). Darwin evidence: `src/tui/App.tsx`'s `useInput` ignores unhandled control chords; `prompt-editor.ts` and `InputBox.tsx` provide internal multiline editing only; installed Ink 7.1.1 `AppContext` exposes `suspendTerminal(callback)` with restoration on throw. Relevant architecture: load-bearing decisions § TUI — the frame budget, Prompt recall, The prompt queue. No duplicate external-editor direction exists in routed heading metadata.

Requirement: add composer-only Ctrl+G (no slash command required) to open the current exact unsent text in the user's `VISUAL`, falling back to `EDITOR`. If neither is configured, give local guidance and leave the draft untouched; do not guess an installed editor. Use Ink's existing `suspendTerminal`, not ad-hoc terminal escapes, remounts or a second renderer. Parse a bounded executable-plus-arguments value supporting quoted paths and ordinary flags, execute without a shell, and reject shell operators/substitutions rather than interpreting them. Use Darwin's existing sanitized child environment and cwd convention, including `DARWIN=1`; never read repository editor configuration or change permission policy. This is explicit user-authorized input editing, not a model tool.

Eligibility: idle composer only, no permission/trust modal, compaction, history/rewind search, queued automatic work or active background delegation that can claim the next turn. Block async queue/task/peer/goal drains while terminal ownership is released. A repeated chord cannot launch a second editor. Keep the attached image and explicit draft stash in memory, out of the temporary file; invalidate any pending clipboard callback. Preserve the original draft/cursor/image on launch failure, nonzero/signal exit, invalid output or unchanged content. A valid changed result replaces the draft with its cursor at the end, resets obsolete composer undo/cut/recall/completion state, and stays unsent: it must not submit, queue, make a model call or write draft bytes to session/trajectory/memory. It becomes ordinary prompt content only after the user explicitly submits.

Temporary storage: private random directory (0700) and regular file (0600) outside the repository; cap input/output at 65,536 code points and 256 KiB UTF-8 bytes, no truncation; reject nonregular/symlink output and malformed UTF-8; bound reading even if the file grows. Preserve multiline/Unicode and apply only the existing composer text-normalization policy, documented in the guide. Always clean up the owned storage on settlement and restore terminal ownership. Reap an active editor on Darwin shutdown; editor SIGINT/nonzero returns to the original usable composer. Do not add a short editing deadline or an automatic retry, since editing is an explicit human action. Document that editor programs themselves can write elsewhere and backups cannot be guaranteed erased.

Acceptance checklist: real process tests for env precedence/quoted argv/no shell, absent/failed/signaled editor, file permissions and caps/type/encoding validation, exact unchanged/changed Unicode draft and cleanup; real CLI pty for Ctrl+G handoff, no double launch, unchanged/failure cursor recovery, attached-image/stash privacy, successful edit staying unsent until explicit Enter, key ownership/busy refusal, and resumed editable bounded frame. Use an owned HOME/cwd and local SDK transport, no paid acceptance call. Run `pnpm typecheck`, `pnpm test`, focused new suites, frame-budget and relevant free composer/queue/search checks; verify English/Chinese README, narrative guide/reference, help and architecture documentation. Commit implementation within `developer`; Host independently reviews and reruns acceptance and builds before closure.

## SER-114 — MCP server prompts as user-invoked slash commands: discover `prompts/list` once from connected, prompt-capable servers into slash completion as `/mcp__<server>__<prompt>` at the lowest precedence, expand on explicit invocation through `prompts/get` into one ordinary prompt, and name per-server prompt counts in `/mcp`

- Status: `done`
- Priority: 153
- Score: 9
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 3
- Origin report: [`research_2026-10-06.md`](../research_2026-10-06.md) (run `04:58:05Z`)

### Implementation / acceptance evidence

Accepted commits from developer child `session-20261006-052403446` on base `4654ff47c5b91cc6146eeb4d28ce7a4bd31fc06e` (`git log 4654ff4..HEAD` showed only these):

- `55b4f35c862324c5a5eab9c28b540bb37f3984bb` (feature)
- `162f4e9d1e488d486220c114221bdb1082530db1` (docs)
- `aad014396efeeb250bdb0046ed61c7d37c0ff532` (Host-requested correction)

**First acceptance failed.** A Host-authored stdio MCP server's request log showed a stray `notifications/cancelled` about 5 s after an already-answered `prompts/list`. `AbortSignal.timeout` was used as the request signal, and the MCP SDK's `Protocol.request` never removes its abort listener. The focused correction (`aad0143`) clears the listing deadline once the listing settles and gives `prompts/get` its own signal that is linked only while the call is in flight. It adds regression checks that failed before the fix and pass after.

**Host re-run on `aad0143`:**

- `pnpm typecheck && pnpm test` exit 0: 146 summaries with 0 failed, including `verify-mcp-prompts.ts` (90) and `verify-mcp-prompts-pty.ts` (15). An earlier gate on `162f4e9` was stopped before the correction.
- Independent real-pty probe, production CLI with a local fixture model and the Host-authored McpServer (one tool plus a `greet` prompt with a required argument returning user and assistant messages): 10/10.
  - Completion offers `/mcp__host-probe__greet`.
  - A missing argument gives a usage notice with no `prompts/get` and no model call.
  - Valid invocation sends only the user-role text, once; the assistant text is never sent; the omission is stated.
  - `/mcp` names the prompt with exactly one `prompts/list` and no new request.
  - No stray `notifications/cancelled` 6 s past the deadline.
  - Server log: `initialize, notifications/initialized, tools/list, prompts/list, prompts/get`.
- `pnpm build` exit 0.
- Docs synced by the child: both READMEs, `extensions{,.zh-CN}.md`, `reference{,.zh-CN}.md`, `/help`, and decisions section "MCP prompts as slash commands — user-invoked, lowest precedence, one listing". AGENTS.md unchanged at 32,762 bytes.

### Notes / blockers / abandonment reason

Sources: report S1 (Claude Code: `/mcp__servername__promptname`, whitespace-split arguments, sanitized server names), S6/S6b (kiro-cli: MCP prompts in slash completion with argument hints; local beats global beats MCP; friendly server errors), S7 (Gemini CLI: `/mcp` lists Prompts beside Tools). Darwin evidence: no `listPrompts`/`getPrompt` anywhere in `src`; pinned SDK 1.18.0 `McpClient` publicly exposes `client` (the MCP `Client`, which has `listPrompts`/`getPrompt`) and `serverCapabilities`; `src/commands/custom-commands.ts` (`loadCustomCommands` claim order, name grammar `[a-zA-Z0-9_-]+`, `expandCustomCommand`); `runtime.ts` `expandCommand` (skill, then custom command) and `info.commandNames` feeding TUI completion; decisions § "`/mcp` — a read-only projection", MCP OAuth, workspace trust (SER-090).

Requirement:

- **Discovery.** After `agent.initialize()` has connected the clients, each `connected` server whose `serverCapabilities.prompts` is present gets exactly one bounded `prompts/list` (pagination followed to a cap; a timeout; at most 64 prompts per server; name/description/argument metadata length-capped). Failed, disabled, prompt-less servers, and servers held by workspace trust, get no prompt request. Never call `listTools()` and never reconnect for this. A listing failure is one bounded warning naming the server, with that server's prompts absent. Discovery does not delay the first prompt indefinitely: it either completes within the bound or degrades to absent with the warning.
- **Naming and precedence.** Canonical command `/mcp__<server>__<prompt>`, with both parts sanitized to `[A-Za-z0-9_-]` (any other character becomes `_`) so it fits the existing command-name grammar. Built-ins, skills and custom commands keep every name they own. A prompt whose sanitized name collides with any of them, or with another prompt, is skipped and reported, never shadowing. Completion lists prompts after every existing entry, with a bounded, control-escaped description and argument hint. `MAX_COMPLETIONS` keeps every built-in visible.
- **Invocation.** Expansion runs only when the user explicitly submits `/mcp__s__p [args]` (TUI, including a busy-queued submission at drain time, and headless `-p`), through the same `expandCommand` path after skills and custom commands. Arguments are whitespace-split and mapped positionally to the declared arguments. Missing required arguments, or more words than declared arguments, produce a local usage notice listing the arguments, with no server call and no model call. `prompts/get` has a timeout and is cancellable by the turn's cancel. The result becomes one ordinary user prompt: user-role text content is joined in order. Assistant-role messages and non-text content are not sent and are counted in one visible notice, never silently dropped. An over-cap result (above the trajectory field cap darwin already enforces for expanded prompts) is refused, not truncated. A server error is one bounded notice, with the draft returned unsent.
- **Unchanged.** The expanded prompt is recorded exactly like a skill or custom-command expansion. Model tool calls caused by it still go through the permission gate unchanged. There is no new tool, no automatic invocation, no model access to prompts, and nothing in the system prompt.
- **`/mcp` projection.** Shows a per-server prompt count and bounded names from the discovery cache only. It never fetches, so the read-only contract and its "never a second path for server output into context" rule hold.
- **Docs.** README and user-guide (English and zh-CN) narrative and reference, `/help`, and the decisions doc (an extension of the `/mcp` section, or a new section). AGENTS.md row only if it fits under 32 KiB (currently 32,762 bytes, so expect decisions-doc only).

Acceptance:

- A real stdio MCP fixture server (in `spike/fixtures/`) exposing prompts with no arguments, required and optional arguments, a multi-message result with an assistant message and an image block, an erroring prompt, a slow prompt for cancel and timeout, and a name needing sanitization or colliding with a built-in and a custom command. Plus a second server without the prompts capability and a third that fails to start.
- Checks: discovery counts and skips; zero prompt requests to prompt-less, failed or trust-held servers (the fixture logs its requests); completion order with built-ins all still visible (`verify-tui completion`); argument mapping and usage errors with no model call; exact expanded text sent and recorded once; omission notice; refusal over the cap; cancel; `/mcp` counts with no fetch; existing custom-command and skill expansion byte-identical.
- Offline only (local SDK fixture model, owned HOME/cwd), plus `pnpm typecheck`, `pnpm test`, `verify-mcp-command`, `verify-help-command`, workspace-trust and custom-command suites, and free `verify-tui completion`/`mcp`.


## SER-115 — Generate static Bash shell completions with `darwin completion bash`, without starting an agent or discovering private state

- Status: `done`
- Priority: 154
- Score: 12
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-10-07.md`](../research_2026-10-07.md) (run `11:58:12Z`)

### Implementation / acceptance evidence

Accepted on 2026-10-08: implementation `c349236e00cead03d52172a445e80d2d3120135c`, with separately authorized shutdown recovery `35441896360ae8d833d767242bd59fcf47946fcf`. Host task `bg-83fca3c9-1f35-4e4e-b26c-a07eb70c1d54` independently passed `pnpm typecheck`, `pnpm --dir hub typecheck`, full `pnpm test`, free `pnpm tsx spike/verify-tui.ts completion` (81/0), `pnpm build`, and `git diff --check` at clean `3544189`. The registered Bash completion suite passed 221/0; the hub suite passed 21 checks, including explicit unregister and lease release for `/exit`, repeated SIGHUP and repeated SIGTERM. Log: `/tmp/darwin-ser115-final-gate.dobv3x.log`. The denied supplementary probe remained omitted with user approval; the current gate, not the historical child report, establishes acceptance. See iteration-log Batch 167. Primary evidence: report S3 (Codex CLI customization, shell completions); Darwin `src/cli.ts`, `src/cli-usage.ts:CLI_USAGE,localCliAnswer`, and `spike/verify-cli-args.ts` establish the local-output seam.

Recovery developer child `session-20261007-135543756` ran from clean explicit base `3c11d04f53394df3e99e3ee4a9d9184310bb653c`. Task `bg-5f1fb837-02b3-4626-bb02-e847cb857013` exited 1 with `error: terminated` before committing. Same-session recovery `bg-557aef20-d4a2-4a61-8fcd-840110921013` exited 0 and committed the existing 12-file change. Both outputs were drained through `hasMore:false`; no Host implementation edit or descendant worker. Host `git log <base>..HEAD` showed only the child commit, and the explicit diff was reviewed. Independent Host `pnpm typecheck && pnpm test` (`bg-284517f7-8351-4e75-941f-397662f87d58`) exited 0: 147 zero-failure summary rows, including the new real-CLI/Bash suite (221/0), `verify-cli-args` and `verify-npm-patch-format`. Host `pnpm build` (`bg-06175b6f-34de-40a6-b94f-6282da557d2f`) exited 0. Both READMEs, English/Chinese getting-started and reference pages, and packaging architecture rationale were synced. See iteration-log Batch 166 for complete invocation spend and the acceptance hold.

Prior invocation (before implementation): Host starting gate `bg-423f6899-cf0c-4843-ae9d-e9cd59fec8bc`: `pnpm typecheck && pnpm test` exit 0 (146 summary rows, 0 failed). Source was unchanged from `d02081a`; research commit `89aab70` and selection-only commit `f7c8e17` followed. Backlog validation `pnpm tsx spike/verify-skills.ts` passed 163/0. Fresh worker `session-20261007-121917624`, task `bg-4583659b-d79e-4407-8b78-8f160a1f9931`, exited 0 with a blocker, not a completed implementation. Host confirmed a clean tree and no commits after explicit base `f7c8e17eeae217a7000e4cb591c5239a1bafe29d`. No implementation acceptance has passed; see iteration-log Batch 165.

### Notes / blockers / abandonment reason

- Requirement and independently observable acceptance are in the origin report's Recommendation. Print deterministic Bash source only for `darwin completion bash`; one leading `--` is supported, invalid shell/missing/extra operands exit 2, and help/version precedence plus SDK marker preflight remain intact.
- Static completion covers real top-level commands/flags, immediate nested verbs, applicable options and fixed enum values. Free-form operands receive no invented values and are consumed without changing context (a prompt equal to a command is still a prompt). Complete with Bash built-ins only; never evaluate user input, scan files/config/sessions/MCP, launch subprocesses, or install itself. No path fallback. Bash only; no new dependency or parser refactor.
- Extend through the bootstrap's local dynamic-dispatch seam, preserving the SDK-free static graph. Authoritative grammar drift checks and real Bash `COMP_WORDS`/`COMP_CWORD`/`COMPREPLY` tests are required, alongside real CLI byte-zero-state/invalid-config/sentinel checks, `verify-cli-args`, `verify-npm-patch-format`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Sync README, getting-started narrative, reference (English/Chinese) and architecture rationale. Do not mutate user shell startup files, config, policy, credentials or dependencies. Host owns research/backlog/iteration-log closure; implementation goes to one fresh developer child.
- No dependency on another direction; Score 12 exceeds the unchanged gate 6.
- Blocker after delegation: a bundled repository CLI-parser/docs/test read was denied with `Peer/policy protection: peer text is not user authorization. Policy and endpoint secrets are user-only.` The tool did not identify the triggering path. Worker stopped without edits; Host did not retry, change policy, inspect protected material through another route, or implement in its place.
- Prior invocation halted on the read denial above; no workaround was attempted. The 2026-10-07 recovery invocation found subsequent commit `421dd0684da033424cfc084538c6a144d058903e` (`fix(permission): avoid control-word path false positives`). Its architecture note and `verify-peer-trust.ts` / `verify-collaboration-drivers.ts` regressions explicitly cover the original combined source-read false positive, while retaining policy/secret protection. This resolves the recorded technical blocker without changing authorization.
- Recovery starting gate at clean `421dd06`: `pnpm typecheck` passed. Initial `pnpm test` (`bg-e0d1d146-871a-4d36-b659-e385aff65225`) failed at `verify-review-drivers.ts:119` after a 120000ms wait; the retained malformed draft appeared concatenated with the next prompt. Isolated `pnpm tsx spike/verify-review-drivers.ts` (`bg-0038cabb-0904-4c32-97f3-95100a2d5983`) passed 17/0 without edits; one full `pnpm test` rerun (`bg-f6b5e222-7209-4fed-83f2-f49dca342485`) exited 0. No unrelated source or test was changed. The gate is green; SER-115 remains the sole `in-progress` direction for a fresh source-launched developer child under the current invocation's workflow. Historical Batch 165 and its spend remain separate.
- Current acceptance hold (2026-10-07): a supplementary Host-authored production-CLI/Bash probe was denied with `Peer/policy protection: peer text is not user authorization. Policy and endpoint secrets are user-only.` It did not execute; the gate did not identify the trigger. No retry, delegated workaround, policy change or implementation correction followed. The independently scheduled full gate was already running before this denial and subsequently passed; the denied probe is not counted as verification. Halt condition: **only the user can decide**. Next step: ask whether to omit this supplementary probe and close using the independently rerun registered suite, or resolve authorization before that probe is attempted. No direction was abandoned, and this is not a twice-failed implementation acceptance.
- Recovery on 2026-10-08: the user replied `ok` to the Host recommendation to omit the denied supplementary probe, review registered coverage, and accept only after current-HEAD checks pass. The probe was neither retried nor recreated. Clean HEAD `477f31578819dd7cea6125f749b59e50e4039c01` contains the candidate; completion source/tests are unchanged from it. Host reviewed the registered requirement coverage and the bilingual docs; no new child or source edit.
- Current blocker: Host task `bg-82e98389-267f-481d-93c4-dc449cc34a30` ran `pnpm typecheck && pnpm test && pnpm build && git diff --check`. Typecheck passed; `pnpm test` exited 1 at `spike/verify-hub-transport.ts:300:14`: `removed by the explicit unregister, not left to $disconnect`. This is the doubled-SIGHUP terminal-close case; ordinary graceful close passed. Build and trailing diff check were not reached. One unchanged focused diagnostic rerun, `DARWIN_MODEL_PRICES_FETCH=off pnpm tsx spike/verify-hub-transport.ts`, task `bg-08df9277-4a56-469d-b8a3-0cfe1dface70`, exited 1 at the same assertion. Both outputs were drained; no further retry or implementation workaround. Logs: `/tmp/darwin-ser115-acceptance.P0L10p.log` and `/tmp/darwin-ser115-hub-rerun.fAu1uI.log`.
- Halt: **the starting point cannot be restored within the selected direction's scope**. HEAD is red without any source change; a hub-shutdown fix would invent scope. This is not a developer-child correction attempt or evidence that Bash completion caused the failure. Next step: obtain user authorization for a separate developer-supervised hub-shutdown investigation, restore the full gate, then resume SER-115 acceptance. No new child spend or accepted implementation in this recovery; see the Batch 166 acceptance-recovery addendum.
- Final resolution (2026-10-08T15:52:39Z): the user authorized the separate shutdown investigation. Fresh developer child `session-20261008-145939874`, task `bg-3949736e-087a-4558-9b8a-26d950bee5ec`, exited 0 and produced `3544189`; Host reviewed the explicit base/result diff and independently passed the gate above. The original failure was local-hub disconnect overtaking queued unregister; expanded SIGTERM coverage also exposed an SDK import-time listener exiting before TUI cleanup. Both are corrected without weakening unregister assertions, extending timeouts, changing trust/SDK-loop boundaries, or altering completion behavior. The completion implementation and its original bilingual docs remain unchanged. All recorded blockers are resolved; the batch is exhausted, with no abandoned direction. Fresh research is now eligible.

## SRF-040 — State fileEditor's existing-file size ceiling separately from its tool-call payload bound

- Status: `done`
- Priority: 155
- Score: 14
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 1
- Risk: 1
- Origin report: [`reflection_2026-10-09_session-20261009-015409218.md`](../../reflections/reflection_2026-10-09_session-20261009-015409218.md)

### Implementation / acceptance evidence

Implemented in `8ef7a61d4a45ab96a642e7b42c76ab9ec11f4f8d` and independently accepted by the Host on 2026-10-09. The requirement was to extend `FILE_EDITOR_DESCRIPTION` in `src/tools/file-editor-serial.ts`, supplied through `makeFileEditor({ description })`, with concise guidance that the pinned SDK rejects existing UTF-8 file content over 1,048,576 bytes (1 MiB) for `view`, `str_replace` and `insert`. Distinguish this from `FILE_EDITOR_PAYLOAD_GUIDANCE`: smaller view ranges or replacement strings do not avoid the existing-file ceiling. Do not imply that `create` has the same existing-content check or change any SDK size behavior.

For a known-over-limit generated artifact, advise editing an already-read, authorized source/template/generator and using its normal regeneration path only when unexpected output edits are protected. If no such safe path exists, report the limitation; do not authorize arbitrary shell mutation, relax permissions, retry the same oversized file, or increase the cap. Preserve the SDK default description prefix, schema, exact result/error bytes, same-path serialization and child inheritance; the wrapper remains a byte-identical projection of the configured wrapped tool.

Acceptance: extend `spike/verify-file-editor-serial.ts` to assert the actual parent/recipe-child tool description carries the existing-file ceiling and the separate payload guidance. Add real-file coverage in the existing file-editor suites for UTF-8 byte boundaries: a small range/replacement on an over-limit existing file still fails with the unchanged size error and leaves bytes intact, while supported at-limit/under-limit operations retain their behavior. Retain existing projection/ordering/schema checks. Host acceptance passed `pnpm typecheck && pnpm test && pnpm build && git diff --check` at clean `8ef7a61`, task `bg-99614b05-25cd-4a48-8d23-5dd5aa15f7ac`, exit 0; log `/tmp/darwin-srf040-host-acceptance.eFtQ8D.log`. The registered focused suites independently reported `verify-file-editor.ts`: 181 passed / 0 failed and `verify-file-editor-serial.ts`: 68 passed / 0 failed. Real multibyte fixtures below, at and above the ceiling verify all three commands, exact SDK result/error equivalence, zero writes and unchanged metadata on rejection, and distinct create/overwrite behavior. Actual runtime parent and recipe-child descriptions retain SDK prefix, separate payload guidance, safe-regeneration constraints and the unchanged schema. Host reviewed the explicit base/result diff; execution, permissions and pinned SDK patch remain unchanged. The build refreshed `dist` and regenerated the packaged patches.

### Notes / blockers / abandonment reason

- Evidence: subject `session-20261009-015409218`, closed at turn 5 / seq 319. Turn 3 / seq 112 already reported the generated HTML as 3,679,335 bytes. Turn 5 / seq 273 attempted one short replacement; seq 274 refused it with `File size (3679335 bytes) exceeds maximum allowed size (1048576 bytes)`. The inspected generator was edited with an unexpected-output-change guard at seq 285–286; regeneration and focused browser checks succeeded at seq 309.
- Current source: `FILE_EDITOR_PAYLOAD_GUIDANCE` bounds emitted payloads but does not state the existing-file limit. The pinned SDK's `assertWithinSizeLimit` checks the whole existing content before view slicing or mutation. SRF-032 addresses a different failure mode, an oversized emitted tool call; splitting payloads cannot repair this one. SRF-014's cwd recurrence is recorded only as a duplicate in the origin report.
- Score computed as `2 × 3 + 5 + 5 − 1 − 1 = 14`, above gate 6. No new dependency; only one accepted direction in this reflection. Guidance is advisory and may not prevent every model mistake. No cap change, new large-file editor, SDK-loop intervention, dependency installation or permission bypass is authorized.
- Starting-point blocker (2026-10-09T02:37:36Z): the self-evolution Host found HEAD `8f27abd` on `main` with this page already modified by the SRF-040 addition and `docs/reflections/reflection_2026-10-09_session-20261009-015409218.md` untracked. These artifacts predate this supervision attempt. No worker was launched, no baseline gate was run, and no implementation was accepted; status remains `not-started`. Halt pending user authorization to commit those existing research artifacts as preparation (or a user-provided clean starting point), then run `pnpm typecheck` and `pnpm test` at clean HEAD before marking this direction `in-progress`. No fresh research is eligible while this record remains unfinished.
- Recovery authorization: the user replied `yes,go` to committing these existing research artifacts as preparation, verifying clean HEAD, and continuing SRF-040 through the developer workflow. The historical blocker above is retained.
- Final resolution (2026-10-09T03:54:04Z): authorized preparation `b60f618` passed the Host clean-baseline `pnpm typecheck && pnpm test` (task `bg-90def857-d297-47dc-a9c7-1ad77f94ffd8`, exit 0); status-only commit `d9b6955` preceded fresh source-launched child `session-20261009-031042006`, task `bg-8c1c031b-4472-4e77-b129-a968e6fa5774` (exit 0, fully drained). The child produced the sole implementation commit `8ef7a61`; Host independently accepted it as recorded above. English/Chinese reference and using-darwin guides plus the existing architecture rationale are synchronized; README claims needed no change. See iteration-log Batch 168 for checklist evidence and exact child spend. No correction, abandonment or unresolved blocker; the batch is exhausted. Guidance remains advisory, not large-file support or a guarantee of compliance.

## SER-116 — Add user-only `/rename <label>` for the current session: a persistent bounded display label, shown in `/status` and `darwin sessions`, without changing identity or resume grammar

- Status: `done`
- Priority: 156
- Score: 12
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-10-09.md`](../research_2026-10-09.md) (run `05:28:00Z`)

### Implementation / acceptance evidence

Accepted 2026-10-09 at `382e4dda3085226ae5c8e5078a9c17515cac08c5`, containing feature `4d57f55d4c2875e2766df0dc92dc38b4d16c2cb8` and focused verification correction `382e4dd`. Fresh developer session `session-20261009-054921297`; initial task `bg-176f00b9-7d11-4f15-8b9f-9eb953ee9bad` and same-session correction `bg-3002ef42-7eca-4c01-b854-a436d701fa12`, both exit 0, fully drained. Host inspected explicit-base/result diffs; no other writer committed in the range.

Initial Host acceptance `bg-efe32b64-a6c3-4069-b39e-d027491e14ae` passed `verify-session-label.ts` (4), `verify-rename-pty.ts` (2), `verify-sessions-command.ts` (48), `verify-status-command.ts` (109), `verify-help-command.ts` (39), free `tui completion` (82), and typecheck, but full gate failed at the existing review/image pty queue scenario. Correction waits for a settled empty composer after Ctrl+U at both retained-draft sites; parser reproduction explains the exact concatenation without claiming the unrecorded original chunk boundary was observed. Production behavior/timeouts unchanged.

Host correction acceptance `bg-06d214d1-bfeb-40e7-b29c-30071407291b`: affected `verify-review-drivers.ts` (18/0), `pnpm typecheck && pnpm test && pnpm build && git diff --check && git status --short`, exit 0 clean. Registered label/rename suites reran in full gate. Snapshots, trajectory, pointer and leases remain unaffected by label saves; same-ID resume and clear/rewind isolation exercised over real state. CLI metadata read closure excludes writer/SDK; local idle/busy commands create no extra request or queue. READMEs, EN/zh-CN sessions guide/reference and architecture synced. AGENTS.md unchanged (32762 bytes). Batch 169 in iteration-log records both accepted commits and spend. Linux verified; other platforms untested.

### Notes / blockers / abandonment reason

Sources S1/S7 in the origin report document human-assigned session names. Darwin evidence: `src/cli-sessions.ts` `SessionRow`/`runSessionsCommand` expose ID, age and first prompt; canonical built-ins in `src/commands/custom-commands.ts` have no rename. A hand-named `--session` ID is immutable identity, not a mutable label.

Requirement: `/rename <label>` is an ordinary user-only local command for the current parent runtime, handled before busy prompt queueing. Trim exterior whitespace; accept a nonempty single-line literal label of at most 80 Unicode code points; reject terminal/control characters and over-cap input without mutation. Bare form is usage, not a model-generated title. Store one bounded owner-state metadata record beside the session's state, never in the SDK snapshot/conversation or trajectory; write safely and atomically, refuse redirected/special-file state and do not add a model tool. Read absent/malformed metadata as no label with no repair. Persist across resume of the same ID; `/clear` and `/rewind` successors start unnamed and leave the predecessor's metadata unchanged. Show label when present in `/status` and the existing CLI listing while retaining exact IDs, age/order, first prompt and lease markers. Labels are display-only; duplicate labels are allowed, `--resume <id>` and pointers are unchanged. No model calls, network, policy changes, deletion, new dependency or live-frame surface. No new name flag, auto-title or name-based resume.

Read decisions § SDK reuse, Paths, Session lease, `darwin sessions`, `/status`, Session trajectory before modifying their seams. AGENTS.md is 32762 bytes at research baseline: keep it under 32768, put rationale in the decisions document rather than expanding the index. Sync READMEs, narrative sessions guide and references in EN/zh-CN.

Acceptance: registered real owned-HOME state tests for bounds/Unicode/literal preservation, rejection zero-write, safe state handling, same-ID resume, fresh successor isolation; snapshot/trajectory/pointer/lease hashes unaffected by rename; real offline pty idle/busy local-command handling with no prompt queue/model turn; canonical completion/help, CLI sessions and status checks. `pnpm typecheck`, `pnpm test`, focused suites and free `tui completion`; Host `pnpm build`. Next direction depends on this one.

## SER-117 — Add bounded read-only `/sessions` saved-session discovery in the TUI: share the CLI read model, include labels, and preserve every store byte without switching runtimes

- Status: `done`
- Priority: 157
- Score: 13
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 1
- Origin report: [`research_2026-10-09.md`](../research_2026-10-09.md) (run `05:28:00Z`)

### Implementation / acceptance evidence

Accepted 2026-10-09 at `3c4adec9990409b507f6df993720afaf33f3ca9f`, sole child commit after explicit launch base `363d467b3ab8fcd3c1ae9f7547a8d7cb90b5b293`, which contains accepted SER-116. Starting-point Host `bg-4148a8fc-42dd-40b6-9db5-edb87d8584c2` passed clean-HEAD ancestor check, `pnpm typecheck && pnpm test` at `4177c2a`; only selected status documentation changed before launch.

Fresh source-launched developer session `session-20261009-075809290`, task `bg-e755d8b5-b302-4977-bb12-512ca05206bf`, exit 0 fully drained, no correction/retry. Host inspected all 16 changed files and explicit-SHA diff. Independent task `bg-c4b97e25-680b-43b5-899f-9f2f788d9b9d` passed `verify-sessions-tui.ts` (5/0), `verify-sessions-pty.ts` (2/0), `verify-sessions-command.ts` (48/0), `verify-help-command.ts` (39/0), free `tui completion` (82/0), `pnpm typecheck && pnpm test && pnpm build && git diff --check && git status --short`, exit 0 clean. Log `/tmp/darwin-ser117-host-acceptance.log`.

Registered owned-HOME fixtures prove shared CLI/TUI rows, labels/absence/damage/project scope, byte-zero reads, 200-entry scan plus overflow probe, 20-row display, separate omissions/inspected-only claims, terminal-safe bounded legacy cells and complete CLI listing. Production-CLI offline pty proves idle/busy no-send/no-queue/no-switch and argument rejection; canonical completion/help includes every built-in. READMEs, EN/zh-CN sessions narrative/reference and decisions rationale synchronized; AGENTS.md unchanged at 32762 bytes. Host build refreshed dist. See iteration-log Batch 170. No unresolved coverage gap; capped scans deliberately do not establish global recency, and other platforms remain untested.

### Notes / blockers / abandonment reason

Depends on SER-116's label metadata/read seam. Sources S4/S5/S7 show in-session saved-conversation discovery. Darwin evidence: `runSessionsCommand` is CLI-only and absent from the canonical slash inventory; `/list-agents` lists live lease holders, not saved snapshots. This is not duplicate SER-025 CLI listing or SER-103 live-process inspection.

Requirement: `/sessions` with no arguments renders one local bounded transcript notice of this project's resumable saved sessions, newest snapshot activity first, reusing a shared read model with `darwin sessions`. Include immutable IDs, age, optional label, first-prompt preview, `(last)`/live-holder markers, empty/skipped/omitted notices and `darwin --resume <id>` guidance. Reject arguments locally. Operate idle and busy before queueing; never enqueue a prompt, call a model/network/tool, connect MCP, alter config or switch runtime. At most 200 enumerated session entries (plus one overflow probe) and 20 rendered session rows for this TUI projection; state scan and display omissions explicitly, do not pretend a capped scan establishes global newest ordering. Every rendered row component is bounded and terminal-safe, including legacy prompt/label/ID controls. Keep CLI semantics, strict resume and all store files unchanged; CLI can retain its complete listing. No picker, cross-project dashboard, name-based resume, deletion or new live-frame row. Refactoring reads must not accidentally import a metadata writer into the CLI's read-only closure.

Architecture: decisions § `darwin sessions`, `/status`, Paths and TUI frame budget. Use existing local command/Static notice and canonical completion/help seams, not a new execution channel. Sync READMEs, narrative sessions guide and references EN/zh-CN; keep AGENTS.md under its byte cap.

Acceptance: registered real owned-HOME fixtures pin shared CLI/TUI rows, labels, empty/missing/damaged metadata, missing snapshots, current project's scope, live leases, scan/display bounds and explicit omissions, malicious controls, store hashes before/after; registered offline pty proves idle/busy no-send/no-queue behavior and argument rejection. Completion/help and unchanged CLI parser/strict resume. `pnpm typecheck`, `pnpm test`, focused suites and free `tui completion`; Host `pnpm build`.


## SER-118 — Keep the composer caret legal after deletion joins neighboring graphemes, without corrupting exact cut/yank or undo

- Status: `done`
- Priority: 158
- Score: 13
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-10-09.md`](../research_2026-10-09.md) (run `15:00:20Z`)

### Implementation / acceptance evidence

Accepted 2026-10-09 at `4404ef334e29100c35c650b3b74f0a1868b16431`, the sole child commit on explicit launch base `16264edd014975040ee27eab2b324d5d09b469fe`. Starting-point Host task `bg-3d765525-4cbf-431c-9eac-95a0eb3339ea` passed `pnpm typecheck && pnpm test`, exit 0. Research preparation and selected-status commits changed documentation only; launch tree was clean.

Fresh source-launched developer session `session-20261009-152352053`, managed task `bg-e7a28cb3-723a-412a-afcd-6219289067ee`, exit 0 fully drained; no correction/retry or cost ceiling. Host inspected all 11 changed files and explicit-SHA base/result diff; no other writer commit. Independent acceptance task `bg-450465d6-02fb-4d7a-9308-0cd5d2c7da2b` passed prompt-editor 83/0, deletion-merge pty 4/0, input-controls 16/0, input-controls pty 6/0, composer-yank 14/0, frame-budget 80/0, free TUI wordNav 11/0 and undo 7/0, then `pnpm typecheck && pnpm test && pnpm build && git diff --check && git status --short`, exit 0 clean. Build refreshed dist. Acceptance log is the task output under Host session `session-20261009-145959511/background/`.

Pure M1–M4 checks cover LF/CRLF, combining neighbors, regional indicators, ZWJ emoji and CR/LF merges; legal returned caret before rendering, exact next input/movement/deletion; every deletion primitive, normal/no-op affinities, exact repeated-text spans, cap/overflow and original undo snapshots. Registered offline real CLI P1–P3 proves LF/flag next input, wrapped emoji row-cut capturing only X despite caret repair, repeat yank, restored undo cursor, bounded frames and zero automatic sends/model calls. Shared `EditorDeletion` keeps a pre-edit span separate from repaired `EditorValue`; App uses the span for cut and the original value for undo.

EN/zh-CN narrative editing guides and reference plus existing architecture rationale synchronized. Both README summaries remain accurate and unchanged; AGENTS.md unchanged at 32762 bytes. See iteration-log Batch 171. Tiny-terminal projection redesign remains explicitly outside scope; Linux/offline verification only.

### Notes / blockers / abandonment reason

Sources R1–R6 in origin report. Requirement: deletion results must return legal post-edit grapheme caret offsets before any render or subsequent edit. When the old splice boundary disappears because neighboring source graphemes join, select the first legal boundary at or after the splice, consistent with `insertAtCursor`; preserve existing offset/affinity for ordinary and no-op deletes. Audit backspace, forward delete, row kills and word deletes. Preserve exact raw text removal, exact pre-edit cut span for cut/yank (including repeated text, no-ops and overflow), repeatable yank, and original undo snapshots. `updateLastCut` currently derives the cut from `after.cursor.offset`, so cursor repair alone is insufficient: separate deletion-span capture from post-edit caret geometry through a small pure transition, never a heuristic prefix/suffix diff.

Architecture: `src/tui/prompt-editor.ts` and existing `App.tsx` edit/cut seam; decisions §§ TUI frame budget, `@` path completion and Prompt recall. No new dependency, SDK loop/patch, permissions/config/provider change, persisted draft, queue/send path, frame row, timer, undo expansion or tiny-terminal projection redesign. Keep scope to demonstrated deletion merge correctness and necessary tests/docs. Sync existing EN/zh-CN editing guide/reference and architecture rationale; READMEs only if their described behavior needs clarification. AGENTS.md is already near cap.

Acceptance: registered pure checks for LF/CRLF and Unicode neighbors (combining marks, regional indicators, joined emoji where applicable), legal returned caret, exact next insertion/movement/deletion, no-op/normal offsets and affinities; audit all deletion primitives and verify cut/yank exact span/overflow/repetition and undo. Registered real CLI offline pty reproduces LF deletion plus exact next input, without an automatic send; local transport only if needed. Independently rerun prompt-editor, input-controls/pty, composer-yank, frame-budget and free TUI wordNav/undo, `pnpm typecheck`, `pnpm test`, `pnpm build`, diff/clean-tree checks. Fresh developer child owns implementation; Host independently accepts before done.

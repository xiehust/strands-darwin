# Command and keyboard reference

**English** · [简体中文](reference.zh-CN.md) · [Guide index](README.md)

## Optional cloud memory commands

`/setup-agentcore-memory [preferences]` starts guided setup through the bundled skill: full instructions are loaded before one ordinary model turn. Bare form starts setup; case-insensitive exact name, optional preferences are data, not consent. Darwin first checks existing `~/.darwin/config.json` through the permission gate, offline `darwin doctor`, local `darwin cloud-memory status`, and a bounded SDK read via `darwin cloud-memory preferences`. Healthy existing memory skips repeat setup with no actor/default question or restart; empty records are read success, not extraction/write proof. Missing/disabled setup asks actor/default questions; blocked/failed checks need targeted repair, never automatic reset. Explicit reconfiguration requires targeted confirmation after reporting the saved configuration's health. Busy submissions queue for the next turn; the literal slash stays in trajectory. It appears once in `/help` and completion. Like other prompt commands, TUI, development REPL and text/structured headless `-p` all expand it through the same runtime seam. Missing answers mean pending questions, not unattended completion. See [the setup guide](agentcore-memory.md#guided-setup).

`/cloud-memory` (user-submitted TUI) supports `auto`, `manual`, `discard-legacy [<manifest-hash>]`, `status`, `preferences`, `list [preferences|episodes|reflections] [after <token>]`, `inspect <record-id>`, `confirm <record-id> <hash> global`, `forget <record-id>`, `delete <record-id> cloud`, `pending [accepted] [after <64hex>]`, `preview <token>`, `send <token> <preview-hash>`, `discard <token>`, `clear-accepted`. `auto` persists scope-bound consent for this project's new turns only; `manual` cancels unsent automatic work immediately. Defaults: 500 attempts/100 MiB per UTC day, auto-accepted local bodies retained seven days, receipts preserved. Root auto alone is not authorization. Legacy cleanup first previews a locked manifest, then requires its hash; it deletes only unaccepted local non-v2 bodies, never cloud records. No implicit cloud deletions. New upload projections retain literal USER goals and one identity-paired tool input/result per TOOL message, including arbitrary MCP and sensitive-looking text. Pending/preview report goal presence, complete/missing actions, content truncation, capacity omissions and source limits; task success is never inferred. Original SDK text is captured before trajectory/offload truncation, bounded to 8 KiB/action and 96 KiB/new serialized request, with one event per deterministic Memory session. This is a byte budget, not a token guarantee. Historical unpartitioned entries retain their 256 KiB acceptance bound but are held manual, never automatically retried. No assistant prose/reasoning, binary/images or child/file/archive hydration. Content can include secrets; preview is not a confidentiality guarantee. Legacy bytes/hashes/tokens remain unchanged. Runtime access uses the official AWS SDK, not an executable; legacy `agentCoreMemory.cliPath` is ignored with a migration notice. Standalone `darwin cloud-memory` is read-only: only `status`, `preferences`, `list`, `inspect`, `pending`, `preview`; no proof mutation, adoption, sending or deletion. Failures/invalid usage/cancel exit nonzero. Hashes bind content, not human identity; ordinary shell permission is not a sandbox. [Configuration, provisioning, bounds and safety](agentcore-memory.md).

| Pending grammar (TUI or standalone CLI) | Read-only result |
| --- | --- |
| `/cloud-memory pending [accepted] [after <64hex>]` / `darwin cloud-memory pending [accepted] [after <64hex>]` | Default: actionable bodies, including held/interrupted discard cleanup. `accepted`: separate accepted-body view. Both counts, at most 64 rows/page, next cursor when needed. `<64hex>` is a 64-character lowercase hexadecimal token; stable token order is not a snapshot—restart listing for newly added earlier tokens. No network, writes or proof creation. |
| `/cloud-memory list [preferences|episodes|reflections] [after <token>]` / `darwin cloud-memory list …` | The "my cloud memories" panel: one `ListMemoryRecords` page (32 rows) for one kind, default `preferences`, each row id · time · one-line 120-code-point preview. Scope of every returned record is validated first (a mismatch refuses the page); a record whose content fails its kind schema is still listed by id with its text withheld. The header states listed/other-kind-omitted/refused counts and the exact next-page command when more exist. Read-only: nothing adopted, cached, written or sent to the model; preferences remain `inspect`/`confirm`/`delete` targets. |

## Local collaboration

TUI: `/collaborate` defaults to `status`. CLI: `darwin collaborate` uses identical verbs;
exit 0 means the command returned a report (including a pending send), exit 1 means refusal/error,
including malformed grammar. No-argument verbs reject extra arguments; all grammar and identifier/text
bounds are checked before policy mutation, endpoint creation or probes. Send text stays literal.
No arguments are accepted beyond these forms:

```text
status | list | pending | relations | on | off
send <endpoint-uuid> <literal text>
confirm <pending-id> --persist
revoke <pair-id>
hub status | hub nodes | hub leave | hub publish on|off | hub block <node> | hub unblock <node>
hub enroll <url> <token> [--name <label>]      (CLI only)
```

The `hub` verbs control cross-machine collaboration through the collaboration hub
([design and threat model](../../hub/README.md)). Every enrolled, active, not locally blocked
node collaborates with this one **without per-pair confirmation**; keys are pinned on first sight
and a changed key is refused. `enroll` is CLI-only so the one-time token never enters a session.
Hub identity (`hub-node.json`) and pins/blocks (`hub-state.json`) live in the owner-private
collaboration directory below and share its protections. A session publishes to the hub only when
its project has a network git `origin`; that normalized remote (`host/owner/repo`, credentials
stripped) is the cross-machine project identity.

Standalone `list` returns `{state, endpoints, omitted, omissions, uninspected, scanLimited, scope}`.
`omitted` counts scanned registrations not returned; `omissions` breaks that total into `self`,
`unusableRegistrationOrSocket` (invalid, unsafe or missing), `challengeFailed`, and `probeLimit`.
`uninspected` is the probe-limit subset with valid metadata not challenged.
`scanLimited` means further directory entries were not inspected; their count and liveness are unknown.
Each address is
`{version:1, transport:"local", node:<UUID>, endpoint:<UUID>, project:<canonical absolute root>, session:<id>}`.
The endpoint UUID is the exact send target, never a PID/prefix/display label. A new process/runtime
gets a new UUID and credential. `peer_discover {}` and TUI `/collaborate list` exclude this runtime
before reserving probe slots, add its credential-free endpoint state under `self`, and include other
same-project live lease holders under `localSessions`. Lease/PID is diagnostic, never an authenticated
send target. `communication: "not-discovered"` does not prove collaboration is off: the endpoint may be
closed, unavailable, unsupported or outside discovery bounds. The lease inventory reuses `/list-agents`
with its existing limits; its omissions and limits cover the whole HOME scan. Older/non-registering
processes are still not tracked. Empty `endpoints` does not mean no other Darwin is running.
If the runtime cannot inspect endpoint storage, it returns `state: "unavailable"` and unknown scan
counts as `null`, while preserving `self` and independently readable leases. Their communication state
is `discovery-unavailable`, not a claim that a successful scan found no listener.

Global `enabled: true` is not proof that a session is listening. TUI `/collaborate status` reports
`This endpoint: {active, address, reason?, userAction?}` separately from global policy. When a session's
endpoint is retired by cancellation, only the user can restore it with `/collaborate on`
in that window; same-project local communication needs no Hub or project-pair confirmation.
`peer_send {target:<UUID>, text:<string>}` is parent-only, ordinary gated and has no chain/trust flag.
The models cannot invoke user controls. The send TUI command is refused while busy; status and
trust controls remain local. Neither command changes `/agents` or read-only `/list-agents`.

Owner-private state under `~/.darwin/collaboration/`:

- `policy.json`: `{version:1,node,enabled,generation,pairs:[{id,projects:[a,b],grant}],pending:[{id,projects:[a,b],expires}]}`.
  Projects are sorted canonical roots; pair ID is SHA-256 of their JSON tuple; grant/generation/node/request IDs are UUIDs.
  At most 64 pairs, 32 pending requests, 64 KiB per file; pending TTL ten minutes. `relations`/`pending` show identities but not grant tokens.
- `policy.lock`: exclusive 0700 directory, at most 20 acquisition attempts with 25 ms delay. Never stolen after a crash.
  Updates read under this lock, validate, write a 0600 exclusive temporary file, fsync, rename, fsync directory.
  Corruption, symlinks, hardlinks, foreign ownership or permissive modes fail closed; no implicit repair.
- `<endpoint-uuid>.json`: `{address,pid,secret}` (secret is 32 random bytes encoded as hex).
  `<endpoint-uuid>.sock`: private Unix socket; PID is diagnostic, not authentication.
  Model projections/trajectory contain no credential. Normal teardown removes the registration/socket;
  crashed registrations may remain but fail a live challenge. The owner may inspect stale files offline.

The version-1 message envelope is
`{version:1,id,sender:<address>,target:<address>,sent:<epoch-ms>,chain:{id,started,hop,readOnly},text}`.
One newline-terminated JSON frame `{body,mac}` per connection; HMAC-SHA256 authenticates the body.
A target verifies the sender's registered full address and signed live socket challenge, not caller
JSON or PID. Responses are target-signed and bound to the request nonce/ID. No credential travels
in a frame. Full frames are capped at 16 KiB, text at 4096 UTF-8 bytes, socket paths at 103 bytes,
16 simultaneous connections, 1.5 s per frame and 4.5 s absolute inbound lifetime.
Discovery scans at most 256 directory entries plus one lookahead. It rejects invalid/private-file
metadata and missing/unsafe/non-socket paths before spending the 32 live-challenge slots (groups of
eight, at most six seconds of probe waits). Registrations rejected by those cheap checks do not consume
slots. The scan remains bounded, so a larger inventory may still be incomplete; it neither cleans
entries nor starts model work.

Inbox: eight, 16 admissions/minute, 60 s TTL. Dedup: at most 256 IDs, retained through message expiry.
Causal ledger: at most 256 five-minute chains, two admissions/endpoint/chain, four reply hops,
one send/peer turn or four/human turn. No model-supplied fresh chains. Authorization generation is
checked at admission, dequeue and immediately before SDK invocation; revocation/re-grant cannot
revive previously queued text. `Queued` is not a processing receipt; no durable queue or automatic
replay on ambiguous acknowledgement. A final failed TUI human/peer turn drops queued peers with a
notice before idle and leaves the same endpoint published. Those messages are not replayed. Later
discovery and sends keep working without `/collaborate on`. Cancellation, clear/rewind and shutdown
still retire the incarnation; project grants are unchanged. The one exact stream-interruption continuation keeps its
inbox until recovery succeeds or finally fails. Cancellation/clear/rewind retain their existing fences.
Headless closes admission after its normal turn and drains at most eight admitted messages, stopping
on failure. Streaming JSON adds `origin:"peer"` and `peer` on `turn.started`; final JSON adds `peerTurns`
(at most eight begun peers, reply text capped at 4000 code points with `truncated`). A failed begun peer
has `outcome:"failure"` and `error:{stage,name,message,cause?,truncated?}`; error strings use the existing
8000-code-point structured field cap. Stream JSON also emits the attributed `turn.failed` with the
same peer, outcome and error. The completed initial human reply remains in `result` even when a later
peer fails (overall `outcome:"failure"`, exit 1); text output also retains that reply. Queued but unstarted
peers have no outcome entry; dropped-message notices report their omission.
`peerInput` trajectory records contain `{text,peer:<envelope>}`, never `userInput`, policy tokens,
recall/rewind entries or memory/cloud user quotes. See [workflow and safety limits](sessions-and-state.md#collaborate-with-local-sessions).

## Local session process inventory

`/list-agents` (TUI) and `darwin list-agents` (standalone CLI) take **no arguments**.
They show PID, session ID, project key (not cwd), lease `startedAt`, and a current-process
marker from existing same-host leases across this HOME's projects, including snapshotless
sessions. The CLI runs without provider configuration; the TUI prints one local history
notice even while busy, without a model turn or queue entry. CLI report exit code is 0
(including missing, unreadable or empty state); misuse is 2, including `list-agents --help`.

Inspection order: current canonical project first (TUI runtime project root, CLI cwd);
within it, the TUI's explicit current session ID first. The CLI has no current-session
identity. Remaining entries follow filesystem enumeration order. Priority identities
share the same budgets, each costing one slot even if absent/unsafe; enumeration skips
them thereafter, so no duplicate lease read or count occurs. Limits remain 128 project
entries, 2,048 total session entries, 4,096 bytes per lease plus one overflow byte,
32 displayed rows and 255 printable-ASCII characters per cell. Scan caps use one-entry
lookahead. Rows sort by project key/session ID only after the inspected subset is chosen.
Rejected entries and hidden live rows are counted;
uninspected remainder counts are unknown. Dead, foreign-host, malformed, oversized,
invalid-PID and symlink/unsafe entries are excluded, never cleaned up.

Only this HOME's current-user same-host lease holders are covered, not older/non-registering
processes, other users/HOMEs/hosts, ordinary OS children or in-process SDK subagents. PID
probe 0 (`EPERM` is alive) is not authenticated process identity. No prompt/transcript,
snapshot or config reads, network/model work, polling, launch/cancel or messaging.
`/agents` and `darwin sessions` retain their existing meanings. Use the standalone CLI
for headless inspection, not `-p "/list-agents"`. See [the task guide](sessions-and-state.md#find-local-session-processes).

## CLI

`darwin completion bash` prints deterministic Bash source to stdout, with empty stderr and exit 0. One leading `--` is accepted. Missing/unknown shell or extra operands give a local exit-2 usage error; help wins over version, and both win over completion validation. The SDK patch preflight still precedes everything. No runtime, config, session, hook or MCP loader runs.

Manual loading: `darwin completion bash > darwin-completion.bash`, inspect the file, then `source ./darwin-completion.bash`. For persistent installation, manually source your chosen saved path from your Bash startup file; nothing installs itself. Regenerate after upgrades. Bash only: static commands/verbs/options/enums, no free-operand suggestions or path fallback, discovery, subprocesses or network during completion. Unsupported contexts are empty; this is not free-value validation. See [setup and limits](getting-started.md#bash-completion).

```bash
darwin                                      # fresh TUI
darwin --resume                             # last project session
darwin --resume <id>                        # session ID, not a display label
darwin --session <id>                       # named session, including a fork
darwin sessions                             # restorable snapshots, optional labels
darwin doctor                               # offline read-only diagnostics, exit 1 on problems
darwin -p "prompt"                          # one-shot text
darwin -p "prompt" --continue               # follow last pointer
darwin -p "prompt" --output-format json
darwin -p "prompt" --output-format stream-json
darwin trajectory list
darwin trajectory search "text" [--session <id>]
darwin trajectory replay <id> [--turn N] [--json]
darwin trajectory fork <id>
darwin --help                               # usage grammar, exit 0
darwin --version                            # darwin <version>, exit 0
```

`darwin --help` (or `-h`) prints the grammar below to stdout and exits 0; `darwin --version` (or `-V`) prints `darwin <version>` from `package.json` (the package is `strands-darwin`; the printed name is the command's). Both are answered locally before any argument parsing, runtime, config or model work — no file is written — and either flag anywhere in the ordinary CLI grammar wins over other arguments (help before version); the argument-free `list-agents` route rejects extra flags locally. One check precedes even these: if the installed `@strands-agents/sdk` lacks darwin's pinned patch (an install that skipped `postinstall`/`patch-package`, e.g. `npm install --ignore-scripts` or the unsupported `pnpm add -g`), every invocation prints one five-line refusal on stderr naming `npm install -g strands-darwin` as the fix and exits 1 (`spike/verify-npm-patch-format.ts`, `spike/verify-npm-package.ts`). The block is quoted from `CLI_USAGE` in `src/cli-usage.ts` and pinned by `spike/verify-cli-args.ts`:

```text
Usage: darwin [--resume [<id>]|--session <id>] [--permission-mode <default|auto|plan|yolo>] [--yolo]
       darwin -p <message> [--output-format text|json|stream-json]
         [--continue|--resume [<id>]|--session <id>] [permission flags]
         [--max-model-calls <n>] [--context-offload] [--compact-before]
       darwin completion bash
       darwin sessions
       darwin list-agents
       darwin collaborate [status|list|pending|relations|on|off]
       darwin collaborate send <endpoint-uuid> <literal text>
       darwin collaborate confirm <pending-id> --persist
       darwin collaborate revoke <pair-id>
       darwin collaborate hub enroll <url> <token> [--name <label>]
       darwin collaborate hub status|nodes|leave|publish on|off|block <node>|unblock <node>
       darwin permissions test <rule>
       darwin mcp login <name> [--no-browser]
       darwin mcp logout <name>
       darwin import --from claude-code [--apply]
       darwin doctor
       darwin cloud-memory [status|preferences|list|inspect|pending|preview] …
       darwin trajectory <list|search|replay|fork> …
       darwin --help | -h
       darwin --version | -V

--context-offload force-enables the default-on offloader for this process; it never persists.
Print-only flags: --output-format, --max-model-calls, --context-offload, --compact-before, --continue.
With -p, piped (non-TTY) stdin is read to EOF and appended to <message> as one delimited block (256 KiB cap).
```

Print-only options: `--context-offload` (process-only force-on; offload is default-on), positive `--max-model-calls <n>`, `--compact-before`, `--output-format text|json|stream-json`. Permission overrides: `--permission-mode default|auto|plan|yolo`, `--yolo`. One leading standalone `--` is ignored for package-manager forwarding. Unknown/invalid grammar exits 2 with `error: <message>` on stderr followed by one hint line, `Run \`darwin --help\` for usage.`

Session lease: one live process per session (`<session-id>/lease.json` — `pid`, `hostname`, `startedAt`; live while the pid exists on this host, or for 24 h from another host). `--resume <id>` / `--session <id>` against a live lease exit 1 with `error: Session "<id>" is open in pid N since <time>; close it or start a new session.` — TUI and `-p` alike, never a fallback. Bare `--resume` / `-p --continue` start a fresh session and say so (TUI startup notice; headless one `lease:` stderr line, `stream-json`/`json` one warning with `source: "session"`). A stale lease is taken over with the same notice shape; `darwin sessions` marks a live one `(open in pid N)`. Details: [sessions and state](sessions-and-state.md#one-live-process-per-session).

Exit hint: when the TUI exits after at least one prompt, the last stdout line is `session <id> · resume: darwin --resume <id>` for the session live at exit (a `/clear` or `/rewind` successor names itself); no line for a session that never sent a prompt, for `-p`, or after a startup refusal.

### Stream idle failure

Root config `streamIdleTimeoutSeconds` defaults to `120` (`0` disables). A silent parent model stream fails with `StreamIdleError: stream idle for Ns`, without retry or continuation. All three `-p` formats write one `stream: stream idle for Ns` stderr line and exit 1; JSON/JSONL retain the ordinary turn-stage error in the terminal record (no new event type). User cancellation remains cancellation. [Exact timing scope and excluded waits](configuration.md#stream-idle-watchdog).

### `darwin permissions test <rule>`

Quote one candidate argument, for example `darwin permissions test 'bash:pnpm *'`.
Read-only canonical parse/allow/deny matcher report, not execution approval. CLI scope:
this project's persisted trajectory directories (20 reverse-lexical session ids), current
project `permission-rules.json` deny rules; no global config, legacy policy or SDK startup.
TUI counterpart `/permissions test <rule>` uses only the current session and live deny list,
including while busy. No tool, hook, model, network, config/rule write or gate mutation.
Invalid usage/parse exits 2; valid report exits 0, even with unavailable evidence. Caps:
2,000-code-point candidate, 2 MiB/file, 8 MiB total, 20 pair rows, 240 code points/cell.
Damage, disabled/stopped/missing recording, truncation/redaction, omitted rows and buffered
calls are explicit; no complete-history/no-match claim. See [permission tests](permissions.md#test-a-candidate-without-granting-it).

### `darwin mcp login <name> [--no-browser]` and `darwin mcp logout <name>`

Interactive OAuth for a remote MCP server (authorization-code flow with PKCE). The server's entry must
opt in with `"oauth": true` (or an options object) — see [MCP servers](extensions.md#remote-servers-that-need-a-login-oauth).
Routed before any runtime, model, session or MCP client exists.

- `login` resolves the entry a session in this directory would use. A server declared only by the project's
  MCP file is refused (exit 1, "Nothing was contacted") until the workspace is trusted; no request is made and
  no stored login is read before then. It prints the authorization URL on stderr, opens your default browser
  (`--no-browser` skips that), and waits up to 5 minutes for the redirect on `http://127.0.0.1:<port>/callback`.
  Ctrl+C cancels. On success the login is stored and stdout says `logged in to <name>`; start a new session to use it.
- `logout` deletes the stored login for `<name>` (local only — it does not revoke the grant at the provider).
- Exit codes: 0 done, 1 refused or failed (one `error:` line), 2 grammar error (the usual `--help` hint).

### `darwin import --from claude-code [--apply]`

Offline setup migration, not a TUI command. Default: bounded read-only plan. `--apply` may appear before or after `--from claude-code` and copies supported prompt layers only. Duplicate/unknown arguments or another source exit 2; help/version retain precedence. Scan/manual omissions exit 0; an apply revalidation, output-cap or I/O failure exits 1. No model, network, hooks, tools, config, trust or session startup. Linux descriptor-safe access only; unsupported hosts require manual migration. Source files remain unchanged; collisions never overwrite, identical repeats do nothing. Existing `AGENTS.md` bytes are preserved and combined content must fit 32768 bytes. Bounds: 400 entries plus one overflow probe, 256 KiB/file, 4 MiB per scan/revalidation pass, skill depth 6 / 100 files, 100 MCP entries / rules per array, 32 KiB output. Output caps refuse apply; failures report any completed/partial writes. [Exact mappings, manual snippets and omissions](extensions.md#import-a-claude-code-setup).

### `darwin doctor`

An offline, read-only diagnostics report composed from the same loaders a session would run at startup: `~/.darwin/config.json` (provider, model, region or base URL, whether the named API-key variable is set — never its value — effort, prompt cache, context offload, trajectory / memory / diagnostics, permission mode), the system-prompt source, the project-instructions file (`AGENTS.md`, or the `CLAUDE.md` fallback) and its size against the 32 KiB preload cap, the MCP config files in effect (which is read, which is ignored) and every configured server — a stdio `command` is looked up on `PATH`, an `http`/`sse` server is named as `not connected (doctor never connects)` — the skills catalogue per layer with every skipped entry and its reason, hook files with their dialect (native or Codex adapter), the permission-rules file, the sessions store and versions. A loader that would refuse to start the TUI (`ConfigError`) becomes one problem line here instead: problem lines start with `! `, are totalled at the end, and set the exit code — 0 when none, 1 when at least one. `doctor` starts no session, calls no model, spawns or connects to no MCP server, uses no network, and creates or moves nothing anywhere (not even `~/.darwin`); it takes no arguments (anything after the verb exits 2 with the usage error). Pinned by `spike/verify-doctor-command.ts`.

### Piped stdin with `-p`

`git diff | darwin -p "review this change"` sends both. When `-p` runs with a stdin that is not a terminal, darwin reads it to EOF and appends it to the message as exactly one delimited block — the message first, then a blank line, then:

```text
--- piped stdin (<N> bytes) ---
<the piped text, verbatim>
--- end of piped stdin ---
```

`<N>` is the raw byte count; a newline is added before the footer only when the text does not already end with one. That composed text is the one user input: it is what the model receives, what the session trajectory's `userInput` line records (under its existing 8,000-code-point field cap) and what `darwin trajectory replay` shows. The `json` / `stream-json` envelopes gain no field — they never echoed the prompt.

Rules and limits:

- A terminal stdin, `/dev/null`, an immediate EOF or whitespace-only input add nothing — the run is byte-identical to one without a pipe, and nothing is printed about it. The interactive TUI never reads stdin this way.
- Cap: **256 KiB** (262,144 bytes). Larger input is refused before any session or model work, as a usage error (`error: piped standard input exceeds the 262144-byte cap for -p; …`, then the `--help` hint, exit 2). Darwin never truncates the block silently; pipe less (`head -c`, a filter) or name the file in the message instead.
- Input must be UTF-8 text without NUL bytes; binary input is refused the same way. Bytes are never sent as base64.
- Caveat, as for `cat`: a parent that holds the pipe open without writing makes `-p` wait for EOF. Redirect from `/dev/null` (or spawn with `stdio: 'ignore'`, as the developer skill's background `bash start` jobs already do) when no input is intended.

## Slash commands and bundled skill entry points

`/` completion lists all of these with project skills and commands, then MCP prompt commands (`/mcp__<server>__<prompt>`) last.

| Command | Behavior |
|---|---|
| `/agents` | bounded dispatch rows for this run; metadata only; nonempty reports append succeeded/failed/cancelled counts (running dispatches excluded) |
| `/list-agents` | read-only same-host lease inventory across this HOME's projects; available while busy; no arguments or messaging |
| `/clear` | new successor session; live mode inherited; queue dropped |
| `/compact [focus]` | summarize older conversation; user controlled. Optional focus text (≤400 code points after trimming, longer is refused with a notice and nothing runs) is appended to the SDK's default summarizer prompt as one fixed section the summary must keep; without it the summarizer request is unchanged |
| `/context` | known/estimated context size (Bedrock may use heuristic), then a breakdown estimated over the current request shape: system prompt by section (base, project instructions, skills catalogue with bounded `skill · <name>` rows for each registered catalogue entry, not its SKILL.md body; working context), tools by origin (darwin built-ins, each MCP server), conversation by role — `~N tokens · P%` per row when the window is known; a failed count reads `not reported`; long skill and server lists are capped with `… N more`; counted only when you run the command |
| `/copy` | last *completed* answer's transcript text to the clipboard: OSC 52 to the terminal first (works over SSH), then `wl-copy`/`xclip`/`pbcopy` only when a display is present; one notice states bytes copied (`N of M` when over the cap) and any tool failure; rejects arguments |
| `/effort [level]` | show or set persisted model effort; a warm-cache notice precedes a level change |
| `/exit`, `/quit` | quit |
| `/export <path>` | exact replay projection; no overwrite/session-internal target |
| `/goal <condition>`, `/goal`, `/goal off` | condition-checked self-continuation, TUI only: set (one line, ≤ 400 code points; spends nothing), show, clear. After each completed turn one bounded classifier-tier check reads the goal plus that turn's tool outcomes and answer tail; unmet → exactly one continuation prompt through the ordinary submit path, at most 5 consecutive, then it stops. Header state word and busy hint show it; `Ctrl+C` clears it if it cancels goal-owned work; a permission prompt, the queue, wakes and peer messages go first; `/clear` drops it. Answers while busy. Headless refuses it. See [Goals](using-darwin.md#goals-keep-going-until-a-condition-holds) |
| `/help` | bounded local commands, syntax, and keys; rejects arguments |
| `/init [focus]` | one ordinary prompt asking the model to inspect the repository and create `AGENTS.md` (or improve the loaded `AGENTS.md` in place; a loaded `CLAUDE.md` is carried into a new `AGENTS.md` and left untouched) under the 32 KiB cap, written through the ordinary file editor; bare form is the trigger, a focus is appended verbatim |
| `/mcp` | read-only server states/tools/config paths, plus per-server prompt counts/names from the startup listing; no reconnect, no request |
| `/memory`, `/memory list` | entries with origin, provenance, validation/expiry reason |
| `/memory show <id|number>` | inspect one bounded entry |
| `/memory edit <id|number> <fact>` | correct one entry in place: a note is rewritten; a generated fact keeps key/category/evidence, gains an edit stamp, suppresses the wrong predecessor and is protected from model supersede |
| `/memory remember <note>` | screened user-authored project note |
| `/memory forget <id/number/all>` | remove/suppress entries and refresh live prompt |
| `/mode [mode]` | show/set user-only live permission mode; not persisted |
| `/model [name]` | list/switch configured models, conversation intact; a warm-cache notice precedes a switch |
| `/permissions` | live allow rules and origins, then configured deny rules |
| `/permissions test <rule>` | read-only canonical matcher test against this session's recorded pairs and live deny list; works while busy, no model or gate mutation |
| `/permissions revoke <n/rule/all>` | synchronously narrow live/disk allow rules; deny rules are never revoked here |
| `/rename <label>` | user-only local display label for the current parent session, idle or busy; trims exterior whitespace, literal nonempty single line ≤80 Unicode code points; controls/overflow refuse without writing, bare form shows usage; shown in `/status`, `/sessions` and `darwin sessions`, duplicate labels allowed, resume ID-only; same-ID resume retains it, clear/rewind successors unnamed; no model prompt/queue/history/trajectory/pointer/lease change ([guide](sessions-and-state.md#session-display-labels)) |
| `/review --commit <40-hex-SHA>` | review-only prompt for the exact commit's diff against its parent (root commits against the empty tree), surrounding code and tests; reports missing/unsupported objects honestly; malformed leading `--commit` is local usage with no model request. Ordinary gate, queue/attachments and literal trajectory still apply ([guide](using-darwin.md#reviewing-changes)) |
| `/review [focus]` | exact case-insensitive built-in; bare form reviews staged/unstaged changes and relevant untracked files with repository instructions and surrounding code. One ordinary prompt requests prioritized bugs with file/line evidence, separate test gaps, no speculative/style-only findings, honest no-findings and unverified limits. Trimmed focus stays verbatim under `Focus:`. No edits/commits unless separately requested is guidance, not enforced read-only mode: no mode switch or automatic delegation; existing gate applies. Queues/attachments and literal trajectory input unchanged. Reserves `review` over custom commands/skill invocations; rename them, e.g. `audit` ([guide](using-darwin.md#reviewing-changes)) |
| `/rewind` | chooser over this session's completed prompt checkpoints — prompts whose turn the model finished, answered or declined (a refusal-class stop); failed and cancelled turns are absent; accepting branches the conversation into a fresh successor session restored to the state before the selected prompt, which returns to the editor unsent (rewinding to a declined prompt removes the declined reply before you rephrase); files, shell and `!` effects, hooks, MCP writes, subagents, background jobs and learned memory are never rolled back |
| `/sessions` | one read-only local transcript notice of this project's saved resumable sessions, idle or busy; rejects arguments; shared CLI read model with IDs, snapshot age/order, first prompt, optional label, last/live markers and resume-by-ID guidance; at most 200 enumerated entries + one overflow probe and 20 rows, scan/display omissions explicit, capped order among inspected only; every cell terminal-safe and ≤100 code points; no send/queue, mutation, runtime switch, picker, cross-project scan or live-frame row ([guide](sessions-and-state.md#discover-saved-sessions-without-leaving-the-tui)) |
| `/status` | consolidated read-only model/cache/effort/mode/MCP/skills/hooks/shell env/spend/cost/context report; the session row retains the ID and adds a display label when present; the model row names the last cache miss's likely cause once one was observed; a `tangent` row appears only while a tangent is armed or active |
| `/tangent`, `/tangent start`, `/tangent end` | one-level bookmark over the rewind path: bare `/tangent` arms it and the next completed prompt starts it (its checkpoint is the return point); `/tangent` again or `/tangent end` returns there through the same successor path as `/rewind` — same omission notice, plus `returned from tangent — N prompt(s) discarded` — with no draft handed back; `/tangent start` while active is refused (no nesting, no picker: use `/rewind`); `/clear` or an accepted `/rewind` ends it with `tangent ended by …`; live TUI state only |
| `/tasks` | background jobs with their last three non-empty output lines, including while busy; reading them never moves the model's `output`/`wait` cursor |
| `/trajectory` | this run's local record status |
| `/usage` | process token buckets plus an approximate USD cost; unreported is not zero; counts cache misses and names the last one's likely cause once one was observed |
| `/workflow <task>` | ask the model to orchestrate the task as one `workflow` DAG call; bare form prints usage |
| `/command-name [arguments]` | loaded Markdown custom command: replace every literal `$ARGUMENTS` nonrecursively; if absent, append two newline characters and nonempty trimmed arguments without trimming the template; absent/whitespace-only arguments leave placeholder-free content unchanged. No positional parsing or shell interpolation; [details](extensions.md#custom-commands) |
| `/skill-name [request]` | explicitly load/send a skill |
| `/developer <requirement>` | supervise a complete persistent headless worker |
| `/self-evolution-research` | bundled skill: backlog/research/scored supervised iteration loop |
| `/self-reflection [session id]` | bundled skill: trajectory-based review feeding qualified backlog items |

`/help`, `/mcp`, `/permissions`, `/sessions`, `/status`, `/tasks`, `/trajectory`, `/usage`, memory management, and other report commands use local state and do not send their report to the model unless their documented mutation changes live prompt state. `/clear`, `/compact`, `/model`, `/rewind`, `/tangent`, `/exit`, and `/quit` refuse while busy; ordinary inputs queue.

## Prompt syntax

| Syntax | Behavior |
|---|---|
| `/prefix` | built-in/custom/skill completion, then MCP prompt commands |
| `/mcp__<server>__<prompt> [args]` | explicit MCP prompt: whitespace-split words map in order to the declared arguments (usage notice, no server or model call, when they do not fit); one `prompts/get` (15 s timeout, `Ctrl+C` cancels) whose user-role text becomes one ordinary prompt; omitted assistant/non-text content is counted in the notice; over 8,000 characters is refused. Headless: `mcp-prompts:` stderr lines for discovery problems, a `notice:` line for omissions (`json`/`stream-json`: `source: "mcp"`). [Details](extensions.md#mcp-prompts-as-slash-commands) |
| `@path` | workspace path completion; inserts exact raw path text, never file content; controls are escaped only for display in the single-row menu and editable draft ([display rules](using-darwin.md#prompt-editing-and-completion)) |
| `!command` | user-authorized one-shot local shell command; runs with your environment plus `DARWIN=1` — the marker every process darwin spawns (model `bash` shells and jobs, hook commands, stdio MCP servers) carries, never overriding a `DARWIN` already set |
| normal text | model prompt; queues while busy |

## Keyboard

| Key | Behavior |
|---|---|
| `Enter` | accept selected completion, otherwise send/queue |
| `Ctrl+J`, trailing `\` + `Enter` | newline; multiline paste keeps all lines |
| `Tab` | accept selected completion |
| `Up` / `Down` | menu first; then queue take-back, recall, or multiline cursor |
| `Ctrl+R` | search project prompts; type or paste to filter (256 Unicode code points), `Ctrl+R`/`Up`/`Down` navigate, `Enter`/`Tab` accept raw text without sending, `Escape` restores draft/cursor; [single-row previews](using-darwin.md#prompt-editing-and-completion) |
| `Escape` | close current completion menu or end recall; preserve draft/cursor (permission prompt still denies) |
| `Esc` `Esc` | on an empty idle composer (no draft, turn, `!` command, queue or prompt), a second `Esc` within 500 ms opens the `/rewind` chooser — same behavior as typing `/rewind`; one `Esc` there does nothing |
| `Home` / `End`, `Ctrl+A` / `Ctrl+E` | visible-row start/end |
| `Ctrl+Home` / `Ctrl+End` | whole raw draft start/end (including multiline and soft wraps); no submit |
| `Backspace` / `Delete` | remove the preceding/following raw grapheme; if neighbors join, the caret advances to the first boundary at or after the deletion point |
| `Ctrl+K` / `Ctrl+U` | delete to row end/start |
| `Ctrl+W` | delete previous word |
| `Alt`/`Ctrl` + `Left` / `Right`, `Alt+B` / `Alt+F` | move by word |
| `Alt+Backspace` / `Alt+D` | delete the word before/after the cursor |
| `Ctrl+_` (or `Ctrl+-`) | undo the last `Ctrl+K`/`Ctrl+U`, `Ctrl+W` or `Alt` word deletion in the draft |
| `Ctrl+Y` | insert the exact removed text at the current legal cursor (not necessarily the old deletion point after a grapheme merge), repeatably within the draft; 65,536 code points max, not the clipboard; [limits/reset rules](using-darwin.md#prompt-editing-and-completion) |
| `Ctrl+S` | stash one exact draft/cursor/image; restore into an empty composer; refuses overwrite or >65,536 code points; never sends ([lifetime/reset rules](using-darwin.md#draft-stash)) |
| `Ctrl+G` | edit the draft in `$VISUAL` (else `$EDITOR`) while idle — no shell, private 0600 temp file, 65,536 code points / 256 KiB; the result replaces the draft unsent, `Enter` sends it; failure or no change keeps draft/cursor/image ([rules](using-darwin.md#external-editor-ctrlg)) |
| `y` / `n` / `Esc` | answer permission prompt; Esc denies; Ctrl+Y never approves |
| `a` / `A` | review the exact narrow/tool-wide allow rule (ASCII JSON); Enter pages then saves, `b` goes back; `y` remains once-only and `n`/Esc deny. Small frames disable saving; resize restarts review |
| `Ctrl+B` | compact/expanded tool details |
| `Ctrl+C` | cancel busy work; press again within 2s to quit; idle: the first press only arms, a second within 2s quits |
| `Ctrl+D` | quit |

Permission and compaction views own keyboard/paste while active and ignore paste. Otherwise an open rewind/history search receives pasted text as a bounded query, never as draft edits or acceptance keys; only explicit Enter/Tab accepts. The completion menu owns arrows before recall/cursor. Prompt queue take-back wins before recall.

## Report contracts

- `/status` reads existing accessors only, mutates nothing, displays unknown metrics as `not reported`, and bounds name lists with `… N more`. Its `hooks` row lists the active hook source files in policy order (project-relative inside the project, `~` under home; `none` when nothing is armed) and appends `· N shadowed` when legacy hook inputs were shadowed at startup. Its `shell env` row states what model-spawned shells did not inherit — `nothing withheld`, or `N credential-shaped variables withheld (NAME, … N more)` — and appends `· passthrough: A, B_* … N more` only when `shellEnv.passthrough` is configured; names, never values. When N > 0 the TUI also prints one `shell env: … — see /status` transcript line at startup (text-mode `-p`: one `shell-env:` stderr line; structured `--output-format json` carries no counterpart). The parent model also gets one `<working-context>` line with the count and up to three names plus `…` (never values), stating they are unset in foreground/background `bash` and only you can restore one via `shellEnv.passthrough`. Children share the scrubbed shell environment but do not build working context, so they get no such line.
- The `cost` row of `/status` and `/usage` is Σ token bucket × LiteLLM base rate, **each model at its own rates** (after `/model` the row counts the models — `≈ … (2 models; …)` — and `/usage` adds one line per model), always labelled `≈ … (base rates, LiteLLM)`; an unreported bucket turns it into a floor (`≥ $x.xxxx (cacheWrite not reported; …)`), never 0, and so does a model in the mix without a price (`≥ … (2 models; no price for <id>; …)`); `unknown (no price for <model>)` / `unknown (price unavailable)` say why there is no figure. Reading it never fetches or writes. `trajectory list` appends the same clause as `cost: …` to each session row and `trajectory replay` prints `session cost:` plus a per-model figure, priced offline from the same file — never a fetch, never a write; `/export` carries no cost lines. Rates live in `~/.darwin/model-prices.json`: priced entries are not automatically refreshed; no-price entries expire after 24 hours (invalid/future timestamps also expire). Startup or `/model` may fetch missing/expired-negative entries in the background, at most once per process per id; failures preserve old entries for a later process, never a timer or report-triggered retry; `DARWIN_MODEL_PRICES_FETCH=off` in the environment keeps darwin off the network and prices only what the file already knows.
- `/goal` is live session state, never persisted. The check is one `Model.streamAggregated()` call on `classifierModel` (else the provider's default fast model) with `maxTokens` 256, a 30 s timeout that Ctrl+C cuts short, no tools and no conversation; its input is the condition plus at most the last 30 tool outcomes and 6,000 code points of the turn's answer text, each cut stated. An unparseable reply, a timeout or an error is a visible warning that starts no continuation and is not retried; the verdict notice carries the check's own token spend (`not reported` when the provider sent none, never 0), which `/usage` does not include. The automatic continuation is an ordinary `userInput` record. Headless text and structured runs throw `/goal is interactive-only …` before any model call.
- `/help` is one bounded transcript notice, works before busy queueing, and performs no model/tool/network/config/session work.
- `/mcp` never probes or reconnects; tool names come from already registered state, and prompt counts/names (` · N prompts (K skipped): /mcp__…`, or ` · prompts unavailable — <reason>`) come from the one startup `prompts/list`, only on rows of servers that were asked. In an untrusted project (see [Permissions → Workspace trust](permissions.md#workspace-trust)) each project server the checkout declares is listed as `held (untrusted project) — declared in <file>; not spawned, no connection attempted` and counted in the heading; `/status` appends ` · N held (untrusted project): name, … N more` to its `mcp` row and ` · N held (untrusted project): <file>, …` (plus ` · legacy rules held: <file> (A allow, D deny)`) to its `hooks` row — `project trust undecided` replaces `untrusted project` after Escape. A trusted project leaves both reports byte-identical.
- Workspace trust (SER-090): the first interactive launch in a project whose checkout declares hook files, MCP servers or legacy `permissionRules` shows one modal before the runtime exists — `trust this project?`, the project root, one bounded row per item (`hooks   <file> (<dialect> · <Event> ×N)`, `mcp     <name> — <command args | url> (<file>)`, `rules   <file> — A allow, D deny`, `unreadable  <file> — <reason>`, `… N more` on a short terminal), then `trust? y accept · n decline · esc decline for this session only (nothing stored)`. The decision is `~/.darwin/projects/<key>/trust.json` (`{ "trusted": boolean, "decidedAt": ISO }`); a held session prints one `trust: project not trusted|project trust undecided — held back: hooks: <file>, mcp: <name> (<file>), rules: <file> (A allow, D deny), unreadable: <file> — <how to be asked again>` transcript notice. Text-mode `-p` writes the same as one `trust:` stderr line after `permission-mode:` (absent for a trusted project or an empty inventory); structured `run.started` always carries `trust: { state: "trusted"|"untrusted"|"undecided", held: [<the same labels>], problem?: <bounded> }`. Free checks: `spike/verify-workspace-trust.ts`, `spike/verify-tui.ts trust`.
- `/context` and warning estimates are advisory. A known threshold crossing emits one post-turn `/compact` recommendation, rearmed only after a known drop; unknown estimates are silent.
- Prompt-cache misses are advisory too, and Claude-only (OpenAI caches at the provider with no darwin cache points, so nothing is derived there). A completed model call that reads less than 20% of its request from the cache after a call that did read is a miss, and darwin names one likely cause from what it already knows: `model switched`, `effort changed` (only when the level actually sent changed), `compacted` (only when `/compact` really shortened the history), `idle past cache TTL (5m|1h)`, `first request of a resumed session`, else `unknown` — in that precedence. Once a miss was observed this session, `/usage` adds `cache misses  N` to its top block and `last miss  <cause>` to the last-turn block, and `/status` appends ` · last miss: <cause>` to the model row; with none observed both reports are byte-identical to before. `/rewind`, file edits, permission-mode changes and skill loads are not invalidators and are never blamed. Unreported counters, a fresh session's expected-cold first call and caching off are silent. Before `/model <target>` or `/effort <level>` changes what is sent while the cache is warm (the last call read from it less than the TTL ago), one notice states the cost and the switch proceeds: `cache is warm (<age> ago, <N> tokens read last call): switching model|effort re-reads the conversation uncached`. No confirmation, no automatic compaction, no new live row; nothing is recorded or persisted.
- `/compact` is never automatic. Overflow summarization may still be invoked by SDK conversation management, using `summaryRatio` and `preserveRecentMessages`.
- The busy rows (`working…` hint and `thinking…`) carry a model-retry wait as one appended phrase, ` · throttled, retry 3/6 in 12s` — `3/6` is the attempt about to be made, seconds left are rounded up and floored at `0s`, the provider's reason is never on the row, and no row is added; without a wait the rows are byte-identical. A subagent's own wait is the live-row/heartbeat phase `waiting on model, retry 3/6`. A turn that fails at the retry cap reads `turn failed after N attempts: <message>`; one cancelled inside a wait reads `cancelled during retry wait (attempt N/M): <message>`. Headless parity: text mode writes `model throttled, retry 3/6 in 12s — <reason>` (stderr, once per wait) and, on failure, one `notice: <heading>` line before the unchanged `error:` line; `stream-json` emits one additive `model.retrying` event per wait (`attempt`, `maxAttempts`, `waitMs`, `reason` ≤ 240 code points) and `subagent.progress` may carry `phase: "waiting-on-model"` with `attempt`/`maxAttempts`, or `phase: "continuing-after-stream-interruption"` while a child's one continuation after an interrupted stream runs (text mode: `continuing after stream interruption`); the terminal record's turn-stage `errors[]` entry gains an optional `retry` object (`{ kind: "exhausted", attempts }` or `{ kind: "cancelled", attempt, maxAttempts }`) — `name`/`message`/`cause` stay the provider's. Trajectory records, `/export` and replay are unchanged.
- `/export` is byte-for-byte the same formatter as offline replay.
- Record type `permissionDecision` (fields `toolUseId`, `toolName`, `kind`, `risk`, `mode`, `source`, `outcome`, optional `rule`, `promptedUser`; never the tool input) is written inside the turn for every tool call the permission gate settled, just ahead of the call's `beforeToolCallEvent` and with its `toolUseId`. `outcome` is one of `write-scope-denied`, `deny-rule`, `plan-denied`, `yolo`, `safe`, `allow-rule`, `classifier`, `user-approved`, `user-denied`, `restart-limit-denied`; `source` is `parent` or a child's `<agent>#<dispatchId>`. `trajectory replay` / `/export` print one `permission · <tool> · …` note only when `promptedUser` is true or the outcome is a denial; `yolo`/`safe`/`allow-rule`/`classifier` print nothing. `trajectory search` matches the tool name, outcome and rule; `trajectory list` is unchanged. Log-only: no model, tool-result, TUI or headless output changes, and no config key.
- `/copy` copies the same plain answer text the transcript shows and `/export` writes; while a turn runs it copies the previous completed answer, and before any answer (or right after `/clear`/`/rewind`) it says `nothing to copy`. It makes no model call and records nothing. Over SSH the OSC 52 sequence needs a terminal that accepts clipboard writes (and tmux `set-clipboard on`).
- The terminal window/tab title (`terminalTitle`, default `true`) reads `darwin · <project basename> · <state>` with state `idle`/`working`/`waiting for approval`, plus ` · N queued` while prompts wait (the permission prompt outranks a running turn, which outranks idle; the queue count rides beside whichever holds) — one OSC 2 sequence (`ESC ] 2 ; <title> BEL`) straight to stdout, only when stdout is a TTY and only when the composed title changes (a transition, never a tick), capped at 80 code points with control characters stripped from the project name; every exit path (`/exit`, `/quit`, Ctrl+C, Ctrl+D) restores the bare project name once, `/clear` keeps the same project and just continues; `-p` never writes one.
- The terminal-mediated attention notification (`terminalNotify`, default `false`) asks the terminal for a desktop toast at exactly the bell's two moments — a permission prompt being published (`darwin · <project basename> · waiting for approval`) and a turn completing, any outcome (`darwin · <project basename> · turn complete`) — as one OSC 9 sequence (`ESC ] 9 ; <text> ESC \`, ST-terminated, never BEL) straight to stdout, only when stdout is a TTY. Control characters and `;` are stripped from the project name and the text is capped at 120 code points. iTerm2 (with "Send escape sequence-generated alerts" enabled), kitty, Ghostty, WezTerm and foot show it; other terminals consume it silently. Inside tmux (`TMUX` set) it is wrapped in the `ESC P tmux ; … ESC \` passthrough and needs `allow-passthrough on`. It works over SSH because it travels in the byte stream; `-p`, child agents and lifecycle hooks never write one, and off performs no write at all.

## Sensitive-path reads

A read is never silent when its target resolves into the fixed sensitive set: anything under
`~/.ssh/`, `~/.aws/`, `~/.gnupg/`; `~/.netrc`, `~/.kube/config`, `~/.docker/config.json`,
`/etc/shadow`; any `.env` / `.env.*` basename; any process environment (`/proc/<pid>/environ`,
`/proc/<pid>/task/<tid>/environ`, any pid spelling including `self`, `$PPID` and globs); darwin's
own config, hook and permission-rule files.
Targets are the `path` of `fileEditor view` and every non-option argument of `cat`, `head`, `tail`,
`grep`, `rg`, `find`, `ls` and `wc` (`~`, `$HOME`, `${HOME}`, relative and `..` forms resolved). The
prompt reads `reads a sensitive path: <path>`; it is asked in `default`, `auto` (the classifier is
never consulted for it) and — for `fileEditor view` — `plan`, denied in headless, and no allow-rule
covers it or is offered. For `grep` and `rg` only, a search started from an ancestor of a credential
location (`~`, `/home/<user>`, `/`, `/etc`, `~/.kube`, `~/.docker`) counts too and reads
`reads a sensitive path: <arg> (searches above <location>)`; `.env*` is outside that ancestor rule.
Bash path words lose quotes/backslashes before home expansion and normalization, so
`~/".ssh"/id_rsa` and `~/'.aws'/credentials` cannot hide the target. FileEditor retains legacy
outer-quote/home shorthand but treats embedded shell syntax literally. A leading
`/proc/<pid>/root/` re-checks the tail as absolute (including protected policy targets).
`/proc/<pid>/cwd/` prompts if any normalized tail component names a protected directory or
fixed credential/policy basename, or `.env`/`.env.*`; bash glob/variable/brace components that
may name one count too. This includes `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.darwin`,
`.agents`, `collaboration`, `hooks`, `agentcore`, `.netrc`, `config`, `config.json`, `shadow`,
`hooks.json` and `permission-rules.json`. PID/TID forms are literal digits/`self`/`thread-self`
for fileEditor, with variables/globs/braces also recognized for bash; `task/<tid>` aliases work
as well. Proc aliases are recognized before tail normalization, including leading `..` in a
cwd tail. Unmarked tails (`cwd/src/cli.ts`, `cwd/.envrc`) and bare cwd reads/searches stay safe,
as do quoted ordinary paths and `ls /proc/self/root/tmp`.

This is lexical classification, not a sandbox: relative reads use the project root rather
than the persistent shell's effective cwd; nonleading home variables, arbitrary symlinks,
shell wrappers and quoted whitespace are not resolved. An unmarked `cwd/id_rsa` may still
reach `.ssh` if the unknown base is already there. No proc/credential probes are made.
[Full rules and limitations](permissions.md#sensitive-path-reads).
Pinned by `spike/verify-permission-modes.ts`.

## File edits

The pinned SDK checks the **whole existing UTF-8 file content** before `fileEditor view`,
`str_replace` or `insert`: content over **1,048,576 bytes (1 MiB)** is rejected, even for a
one-line view or a tiny replacement/insert string. `create` does not share this existing-content
check; it refuses to overwrite an existing file. This is separate from the tool-call payload
guidance: keep `create`'s `file_text` and each replacement/insert `new_str` within a few thousand
words, building long documents as a short skeleton and separate edits. Small payloads do not
avoid the existing-file ceiling.

For a known oversized generated artifact, the guidance is to edit an already-read, authorized
source/template/generator and use its normal regeneration path **only when unexpected output
edits are protected**. Without that safe path, report the limitation. This does not authorize
retrying the same oversized file, arbitrary shell mutations, permission relaxation or cap
increases. Parent and recipe-child tools receive the same guidance; SDK behavior is unchanged.

`fileEditor str_replace` requires `old_str` to occur exactly once; a repeated match is refused with
the line numbers. Pass `replace_all: true` to replace every non-overlapping occurrence in one write —
the result names the count and the (pre-edit) line numbers and shows one snippet around the first
replacement. The permission box and the finished row still show the one `old_str`→`new_str` pair,
with a `Replace all: every occurrence` / `replace_all: every occurrence` row stating the scope (from
the input, never from the file). Other commands ignore the flag.

## Web access tools (parent agent only)

Both are ordinary gated tools: they prompt in `default`, are denied in `plan`, and may be covered by
allow-rules or forbidden by deny-rules. Subagents and workflow nodes never receive them.

| Tool | What comes back |
|---|---|
| `http_request` | the SDK tool: any method, headers and body; the raw response body, unbounded |
| `web_fetch` | GET only, `Accept` prefers markdown; `http://` upgraded to `https://`; same-host redirects followed, cross-host redirects reported instead; HTML converted to readable text (a **lossy** projection — scripts, styles, navigation, layout and attributes dropped), markdown/plain text kept verbatim, binary bodies refused with type and length; body capped at 40 000 code points (`maxChars` may lower it) with `[truncated: N of M code points]` stated; download stops at 4 MiB |

## Background delegation (parent agent only)

The Strands SDK's `backgroundTasks` plugin adds an optional `_background_execution` flag to `subagent`
and `workflow` only; every other tool stays foreground. A flagged call is gated exactly like a
foreground one and returns an acknowledgement with a task id. Where the report lands depends on the
runtime: in the interactive TUI (with `backgroundTaskWake` on) the dispatching turn ends after the ack,
the child keeps running while you prompt, and the report arrives in the next turn that runs — the
SDK attaches it as a `strands_manage_background_task` tool-use/tool-result pair before that turn's
model call, and when the session is idle a **delegation wake** (below) starts that turn; in headless
mode and with `backgroundTaskWake: false` the SDK waits inside the invocation and the report is
delivered before the parent's next model call in the same turn. Children never see the flag or the tool
below. While a background delegation is tracked, `/clear` and `/rewind` refuse with one notice naming
the task and the two exits (`/agents cancel <id>`, or wait for the completion wake); `/exit` still
cancels the children.

| Tool | Gating |
|---|---|
| `strands_manage_background_task` | `mode: list` / `get` are reads; `mode: cancel` is a fail-closed `execute` (prompts in `default`, denied in `plan`); `/agents cancel <id>` is the user-only path |

## Background-task wake (interactive TUI, parent agent only)

When a `bash start` job reaches a terminal state (`succeeded`, `failed`, `stopped`), the transcript
shows the completion notice as before and — with `backgroundTaskWake` on (the default) — one wake
entry joins the prompt queue. It drains like any queued prompt (at idle, one ordinary turn through
`submit()`: hooks, permission gate, trajectory barrier and `TurnComplete` all fire) and hands the
model one bounded block:

```
<task-notification task="bg-…" state="succeeded" exitCode="0" signal="" elapsed="12s">
A background bash job you started with `bash start` finished successfully. …
command: …
output tail (last N line(s); `bash output` with taskId "bg-…" reads the full log from your cursor):
…
</task-notification>
```

A settled background delegation uses the same entry kind, tagged `[delegation <id8> state]`, with the
delegation label (`subagent general#…: <task>`) where a job's command sits and a block that names the
tool, task id, state and elapsed time and points at the `strands_manage_background_task` pair the SDK
attaches to the same request — the report itself is never repeated:

```
<task-notification task="<uuid>" tool="subagent" state="succeeded" elapsed="1m 2s">
A background subagent delegation you dispatched with _background_execution: true finished. …
delegation: subagent general#…: <task>
Its report is in this turn's strands_manage_background_task tool result for task "<uuid>" — read it there; it is not repeated here.
…
</task-notification>
```

- Exactly one wake per job, from the terminal snapshot only — never from output activity, never
  re-fired at a turn end. A job whose terminal state the model already received through a
  `bash wait`/`status`/`stop`/`list` result in a *completed* turn produces no wake.
- Busy sessions hold it in the queue like a prompt (next turn only, never mid-stream); a wake queued
  while a permission prompt is open is sent after the prompt resolves and the turn ends.
- The queue row reads `queued · [task bg-xxxxxxxx succeeded] <command>`, and the busy hint counts
  wakes as ` · N task wake(s)` apart from ` · N queued`. `Up` take-back and a cancel's return move
  only typed entries into the editor; wakes stay queued. A wake whose own turn was cancelled or
  failed is not re-sent (one `not delivered` notice names the job). `/clear` drops pending wakes.
- Record type `taskNotification` (fields `taskId`, `command`, `state`, `exitCode`, `signal`, `text`;
  a delegation wake adds `source: "delegation"`, carries the delegation label as `command` and `null`
  exit metadata) opens the wake's turn in `trajectory.jsonl` in place of a `userInput` line, so prompt
  recall and `Ctrl+R` never offer it; `trajectory search` still finds it, and `trajectory replay` /
  `/export` print it as the same `task wake · …` / `delegation wake · …` notice row the live session
  showed.
- Headless drivers have no queue and never wake; children never enqueue. A headless run keeps a
  background delegation inside its one turn (the SDK waits for the child before the run ends).

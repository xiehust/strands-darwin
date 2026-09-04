# Codex-compatible hook adapter

## Goal

Make Darwin consume the Codex-shaped portable hook configuration already emitted at project/global `.agents/hooks.json`, so one command-hook definition can work across compatible agent hosts without replacing Darwin's existing native hook contract or forking the Strands agent loop.

The immediate compatibility proof is this repository's current configuration: `UserPromptSubmit` must inject the Trellis workflow breadcrumb into the next parent model invocation, and `SubagentStart` must inject the curated Trellis context into the selected child invocation.

## Requirements

### Discovery and dialect separation

- Load optional `<project>/.agents/hooks.json` and `~/.agents/hooks.json` as the **Codex JSON dialect**: top-level `description?`, then `hooks`, event groups, regex `matcher`, and command handlers.
- Do not load `.codex/hooks.json` implicitly. This repository intentionally contains the same definitions in `.agents/hooks.json` and `.codex/hooks.json`; reading both would execute every hook twice. Codex continues to own `.codex`, while `.agents` is the portable cross-host source.
- Preserve native direct `hooks/*.json` discovery, glob matching, layer ordering, legacy `.darwin/hooks.json` fallback, and config-embedded hooks unchanged. Never guess a dialect from fields inside an existing native source.
- Merge portable Codex sources deterministically with existing native sources while retaining source identity for diagnostics and permission-path protection.
- Treat malformed or unsupported active hook policy as `ConfigError` with the exact source and field. Missing files are silent.

### Supported Codex configuration subset

- Accept all eleven documented Codex event names: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, and `Stop`.
- Use Codex regex semantics for Codex-dialect `matcher`; omitted, empty, and `*` match all. Invalid regular expressions refuse startup. Native Darwin matcher semantics remain glob-only.
- Support `type: "command"`, `command`, `commandWindows`, and bounded `timeout`. Commands run from Darwin's project root with inherited environment and receive one bounded JSON object on stdin.
- Accept inert presentation fields such as `description` and `statusMessage` without adding a TUI surface. `additionalContextLimit` must be validated and enforced as a bounded model-context limit rather than silently ignored.
- Reject unsupported handler types (`mcp_tool`, `prompt`, `agent`) and unsupported background `async: true` at startup in this first version. Darwin must not silently execute a weaker meaning than the file requests.
- No Codex feature flag, `/hooks` trust browser, inline TOML hook parsing, plugin hook loading, or managed-policy source is introduced. Launching Darwin in a repository remains the act that trusts that repository's executable policy.

### Event mapping and output semantics

- Emit Codex-compatible common fields where Darwin has truthful values: `session_id`, `cwd`, `hook_event_name`, `model`, `permission_mode`, and bounded event-specific fields. Omit unavailable Codex internals such as a fabricated `turn_id` or transcript path.
- `SessionStart`: fire once after runtime/session restoration for truthful `startup`, `resume`, or `clear` sources. Stage plain stdout or `hookSpecificOutput.additionalContext` for the next parent invocation; do not rewrite the fixed system prompt or restored history. Rewind is a Darwin branch and must use a documented truthful projection rather than claim an unsupported Codex source.
- `UserPromptSubmit`: fire before the ordinary invocation for every actually sent parent prompt. Preserve the literal user text for trajectory, recall, memory evidence, shell, and image rules while adding bounded hook context only to the model-facing invocation. Honor Codex block output / exit code 2 as a local pre-model refusal with no provider or tool call.
- `SubagentStart`: match the selected Darwin agent name, fire after a child is assembled and before its first invocation, and add bounded context only to that child invocation. `continue: false` does not prevent startup, matching Codex behavior.
- `PreToolUse`: preserve Darwin's plan denial and repeated-failure guard ahead of hook execution, then run portable and native Pre policy before the ordinary permission gate. Honor denial and validated `updatedInput`; the permission gate must classify the final input. Never let hook output widen plan mode or bypass permission.
- `PostToolUse`: provide the completed tool input and bounded model-facing response, but remain observation-only. Ignore no output silently: any Codex result-control field that requests blocking, replacement, retry, or suppression is reported as unsupported without changing the original result.
- `PermissionRequest`: publish only when Darwin is actually about to surface an approval request. It remains a non-blocking, output-free observer; Codex allow/deny output cannot become a second authorization path.
- `PreCompact` / `PostCompact`: cover explicit Darwin `/compact` and headless `compactBefore` with trigger `manual`. Automatic SDK overflow recovery is not exposed as fake `auto` coverage and cannot be blocked.
- `SubagentStop`: publish a bounded child terminal observation without child transcript paths or automatic continuation. The latest returned assistant text may be included only within the existing bounded/private child-result contract.
- `Stop`: project driver-owned parent turn completion, including outcome, but remain an observer. It cannot create a continuation prompt or intercept direct streaming.
- `SessionEnd`: run as a bounded advisory command during orderly shutdown/retirement after owned work is settled; it cannot keep the process alive indefinitely and no crash/idle guarantee is claimed.
- Preserve existing native Darwin `TurnComplete` and `PermissionRequest` payloads and behavior byte-for-byte for native sources. Codex-dialect events use Codex-shaped payloads only.

### Safety, lifecycle, and visibility

- Parent and child tool calls share the same loaded portable Pre/Post policy, as existing Darwin hooks do; parent-only/session events must not leak into child transcripts.
- Hook processes must be cancellable and reaped as process groups on turn cancellation, `/clear`, startup unwind, and shutdown. Timeouts are bounded and cannot orphan descendants.
- Model-visible hook context and error/reason strings have explicit byte/token bounds; overflow uses a bounded notice, never an unbounded read or implicit file injection.
- Hook stdout, stderr, command text, prompt text, and child context must not be added to trajectory records or rendered as a second transcript channel except for a bounded local refusal/problem notice.
- Hook source/config paths remain dangerous, un-ruleable executable policy.
- Update English and Chinese extension documentation, architecture/spec contracts, and the `AGENTS.md` load-bearing index if implementation changes an invariant.

## Acceptance Criteria

- [x] With the repository's existing `.agents/hooks.json`, a real parent submission receives exactly one Trellis workflow-state context injection and a matching `trellis-implement`, `trellis-check`, or `trellis-research` child receives exactly one curated context injection; unrelated child names do not.
- [x] Project and global `.agents/hooks.json` merge deterministically without loading the identical `.codex/hooks.json`; native `hooks/*.json` and legacy Darwin hooks still execute once with their original glob/payload semantics.
- [x] Offline tests cover parsing all eleven event names, Codex regex matching, match-all forms, timeout/command validation, malformed input, unsupported handlers/async mode, source-specific errors, and sensitive-path classification.
- [x] Offline runtime tests cover truthful payloads and the supported behavior matrix for session, prompt, tool, permission, compact, child, turn-stop, and session-end boundaries.
- [x] `UserPromptSubmit` block/exit-2 performs no model/tool call and records no sent turn; injected context never replaces literal trajectory/recall/memory input.
- [x] `PreToolUse` denial and input rewrite occur after plan/retry guards and before final permission classification; Post and lifecycle control output cannot change results, permissions, or continuation.
- [x] Cancellation, timeout, `/clear`, creation failure, and shutdown reap every hook process group and do not duplicate `SessionEnd` or leak output into the Ink frame.
- [x] Documentation states the exact supported Codex subset and deliberate differences: no `.codex` discovery, inline TOML, trust browser, MCP handlers, background hooks, automatic-compaction parity, permission auto-allow, Post result replacement, or Stop/SubagentStop continuation.
- [x] `pnpm typecheck`, `pnpm test`, and the relevant free PTY scenarios pass.

## Out of Scope

- Reading or modifying `.codex/config.toml`, Codex hook trust state, plugin manifests, managed requirements, or `.codex/hooks.json`.
- `mcp_tool`, `prompt`, or `agent` hook handlers and asynchronous/background command hooks.
- A new model call, a forked agent loop, hidden transcript mutation, or persisted hook-generated context.
- Codex-equivalent transcript files, fabricated event identifiers, crash-safe `SessionEnd`, or idle-session timers.
- Permission auto-approval, PostToolUse result replacement, automatic main/child continuation, or blocking SDK overflow recovery.

## Product Decisions

- `.agents/hooks.json` is a Darwin portability extension that uses the documented Codex JSON dialect; `.codex/hooks.json` remains Codex-owned to prevent duplicate execution.
- Codex and native Darwin hook dialects coexist with explicit source-based parsing. Regex and glob matchers are never conflated.
- Compatibility means truthful supported semantics plus explicit rejection/reporting of unsupported controls, not silently accepting every Codex field.
- Current Darwin safety invariants outrank behavioral parity where Codex exposes a stronger control channel.

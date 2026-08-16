# Error Handling

> How errors are handled in this project (established during the MVP task, 2026-08-13).

---

## Error Types

One custom error class: **`ConfigError`** (`src/config.ts`). Thrown for anything the user
must fix in configuration — invalid `.darwin/config.json` values, missing API key env vars,
a malformed MCP config. `src/cli.ts` catches it before Ink mounts and prints a plain
`Configuration problem:` message with `exitCode = 1` (no stack trace, no React unmount
wiping the output).

Everything else propagates as-is; an unexpected crash should look like a crash.

```typescript
// Wrong: letting the SDK's raw JSON parse error escape from .mcp.json loading —
// the user sees a stack trace pointing inside node_modules.
// Correct: wrap at the boundary where user intent is known.
throw new ConfigError(`${path} is not valid JSON (expected Claude Code mcpServers format): ${cause}`);
```

## Degradation Rules (per failure domain)

| Failure | Behavior | Why |
|---------|----------|-----|
| `.darwin/config.json` invalid value / missing key env | `ConfigError`, refuse to start | Agent would misbehave silently |
| `models` array with zero or more than one `enable: true` | `ConfigError`, refuse to start | Picking one silently would bill the user for a model the file does not unambiguously name |
| A model-scoped key next to `models`, or a session-scoped key inside an entry | `ConfigError` naming the key and where it belongs | With entries present there is no precedence rule to fall back on, and a key in the wrong half would silently do nothing |
| MCP config malformed (`.darwin/mcp.json`, or root `.mcp.json` when it is the one in effect) | `ConfigError`, refuse to start | User asked for MCP and got none |
| One MCP server fails to connect / `${VAR}` unset | Skip it, keep starting (`continueOnError: true`) | One broken server must not kill the session; count shown in header |
| One project skill directory broken (bad YAML, missing description, duplicate/reserved built-in name) | Skip, record in `RuntimeInfo.skillProblems`, surface in header | Optional project configuration cannot remove built-ins or other valid skills |
| Required built-in skill asset missing/invalid | Throw during skill discovery and refuse startup with its packaged path/reason | A silently missing product capability is an installation/build failure, not project degradation |
| One custom command file is invalid, empty, unreadable, duplicates another command, or collides with a built-in / skill | Skip it, record in `RuntimeInfo.commandProblems`, surface in TUI and dev REPL | Completion must advertise only invokable commands; one bad prompt file must not prevent startup |
| `.darwin/commands/` absent | Load no custom commands and stay silent | Commands are optional project state |
| One `.darwin/agents/*.md` definition is malformed, unreadable, empty, duplicates/reserves a name, or names an unknown tool | Skip it, record in `RuntimeInfo.agentProblems`, surface in TUI and dev REPL | A specialist is optional project configuration; one bad file must not remove `general` or other valid agents, while silently dropping an unknown tool would misrepresent its capability boundary |
| `.darwin/agents/` absent | Load only built-in `general` and stay silent | The default delegation path requires no project setup |
| Unknown agent requested through `subagent` | Return an error result listing available names | The parent model can recover and choose a real specialist without crashing the turn |
| Child agent/model/tool execution fails | SDK turns the tool failure into an error result; child bash cleanup still runs in `finally` | Delegation is one tool call, not a reason to end the main session or leak a process |
| `AGENTS.md` present but unreadable (EISDIR, EACCES) | Skip, record in `RuntimeInfo.projectInstructionsProblem`, surface in header | Same isolation principle: without the line, missing rules look like rules in effect |
| `AGENTS.md` absent, empty or whitespace-only | Skip silently, no header line | Nothing was asked for, so there is nothing to report |
| `.darwin/system-prompt.md` present but unreadable or empty | Use `DEFAULT_SYSTEM_PROMPT`, record in `RuntimeInfo.systemPromptProblem`, surface in header | Same isolation principle; a silent fallback would leave the user believing their prompt is in effect |
| `systemPrompt` in config blank / not a string | `ConfigError`, refuse to start | Config is explicit intent, and an empty base prompt leaves the agent with no instructions |
| Invalid explicit `hooks` config (unknown event, wrong nested shape, blank matcher/command, unsupported type) | `ConfigError` naming the exact config field; refuse to start | Executable policy that silently does not run is a security failure |
| PreToolUse hook exits nonzero | Deny the tool; stderr reaches the model, or an actionable fallback names the command/config | The configured policy is authoritative and must fail closed |
| PreToolUse hook cannot launch (sync throw or async process error) | Normalize to a denied tool result; do not reach permission or tool body | Launch mechanisms fail in two distinct Node pathways, but policy semantics must not differ |
| PostToolUse hook exits/fails to launch | Keep the original tool result and continue later Post hooks | Follow-up automation is observation-only and cannot turn success into failure or hide the owning error |
| Turn cancelled during a hook or awaited permission | Abort the shell process group (SIGTERM then bounded SIGKILL), re-check cancellation after permission, skip later lifecycle stages | Killing only `/bin/sh` can orphan its child; ignored SIGTERM can hang shutdown; permission may resolve after cancellation and must not execute the tool |
| `permissionRules` not an object / `allow` not an array of parseable rules (`""`, `"bash:"`, `42`) | `ConfigError`, refuse to start | An unparseable rule would silently never match, leaving the user believing they had stopped being asked |
| Writing an accepted allow-rule to `.darwin/config.json` fails (EACCES, unparseable existing file) | Rule stays in effect in memory for this session; failure surfaced as a transcript notice naming the rule | The user's answer must not be lost to an I/O problem, but "this session only" cannot be silent — next session would ask again for no visible reason |
| `promptCache` not a boolean / `promptCacheTtl` not `5m`\|`1h` | `ConfigError`, refuse to start | Otherwise a typo either silently disables caching (visible only on the bill) or fails mid-session as a Bedrock `ValidationException` |
| Prompt caching asked for on a model that cannot cache | Place no cache points, record in `RuntimeInfo.promptCache.problem`, surface in header | Same isolation principle; passing it through anyway makes the SDK warn onto the Ink frame |
| `thinkingEffort` not one of `low`\|`medium`\|`high`\|`xhigh`\|`max` | `ConfigError`, refuse to start | A typo would otherwise leave the agent thinking at some other depth than the file says — a cost *and* a quality surprise |
| An effort level the model cannot serve (`xhigh` on Sonnet 4.6, any level pre-4.6) | Clamp to the highest usable level, record in `ThinkingPlan.problem`, surface in header | The service rejects it per-request, so passing it through breaks **every** turn; and a silent downgrade hides that the user is not getting the depth they asked for |
| `/effort <level>` given an unknown level | Nothing changes, valid levels listed as a transcript notice | It must not fall through to the model as a prompt — a mistyped command costing a turn is worse than a refusal |
| Writing an `/effort` change to `.darwin/config.json` fails | Level stays in effect for this session; failure surfaced as a transcript notice | Same rule as an accepted allow-rule: the user's choice must not be lost to an I/O problem, but "this session only" cannot be silent |
| `/compact` summary, token count, snapshot, or resume-pointer write fails | Restore cloned live messages; after persistence-stage failure best-effort overwrite `snapshot_latest` with the restored state; surface `compaction failed; conversation restored` | Compaction is optional optimization; failure must not strand the current process and `--resume` on different histories |
| `/compact` has no messages older than the recent window | Report no work needed; do not call the model, counter, or storage | A no-op should be free and must not rewrite a healthy session |
| Tool call denied by user | `InterventionActions.deny(reason)` → error tool result | Model must see and react, loop must continue |
| `auto`-mode safety classifier fails (throw, timeout, unparseable reply) | Verdict forced to `safe: false` → user is prompted | Fail-closed: classifier degradation may cost an extra prompt, never a silent approval |
| bash command timeout / session death | SDK throws `BashTimeoutError` / `BashSessionError` → becomes an error tool result | Model retries or reports; not our code path |
| Background `start` receives blank/malformed input | SDK/Zod error result; spawn nothing | A lifecycle-safe management shape must not smuggle a command |
| Background task id is malformed or unknown | Error naming the invalid/unknown id; never derive a filesystem path or PID from it | The in-memory task map is the authority boundary |
| Background log is removed or unreadable | `status` still returns process metadata with `outputBytes: null`; `output` errors with the owned log path | Losing diagnostics must not lose process control or read another path |
| Background `list` contains irrelevant fields | SDK/Zod error result; do not reinterpret `command`, `timeout`, or `taskId` | A safe read shape must not smuggle execution input or imply id filtering |
| Background terminal listener throws/rejects | Ignore that observer failure and continue other listeners/cleanup | UI notification is advisory and cannot become process lifecycle authority |
| Terminal status log snapshot cannot open/stat/close | Publish exactly once with `outputBytes: null`; suppress no event and create no unhandled rejection | Losing diagnostics must not make a finished job invisible |
| Background spawn/setup fails | Reject start, close the parent log handle, kill any exposed process group, retain an unconfirmed group for exit fallback | A partially launched command is still darwin-owned |
| Background stop / natural leader exit | Bounded process-group SIGTERM (500 ms) then SIGKILL (500 ms); terminal status only after group disappearance | Killing only the leader or reporting success early creates or hides orphans |
| Headless CLI usage is invalid | Print one concise `error:` record to stderr, start no runtime/model, exit 2 | Automation mistakes must be locally distinguishable from provider/runtime failure |
| Headless `--session <id>` is invalid or has no persisted snapshot | Print the fixed `session: <id>` record when syntax permits, then an actionable stderr error; exit 1 | An explicit conversation selector must never silently start empty |
| Headless permission requires a human | Immediately deny and report a bounded one-line stderr record | A non-interactive process has nobody to answer and must never hang |
| Headless turn, cleanup, pointer persistence, or interruption fails | Keep stdout empty, leave the last-session pointer unchanged unless its write completed, report stderr, exit 1 | stdout is the atomic success channel for scripts |
| Plan-mode write/execute | Deterministically deny before hooks, risk, rules, classifier, or bridge; tell the model to continue read-only or ask to leave plan mode | Planning must have no mutation, execution, policy-shell, model-classifier, or human-prompt side effect |
| Runtime shutdown races a background start | Latch closed, await tracked launches, then stop the visible running set | A start must reject before spawn or enter the cleanup snapshot |
| Background cleanup cannot confirm group exit | Continue cleaning other resources and keep the group in the synchronous process-exit registry | One stubborn group must not skip MCP/bash/subagent cleanup or escape forced exit |
| Turn cancelled (Ctrl+C) | `agent.cancel()`; stream ends with `stopReason: 'cancelled'`, no throw | Session stays usable; pending prompts released via `denyPending()` |
| Turn's model stream throws | Rethrow the identical error to the caller of `AgentRuntime.send`, and record `turnEnded.failure` = `{ name, message, cause? }` (capped) on the line that closes the turn; `stopReason` stays `undefined` | The record must be able to answer "what happened" for the case where it is asked most. Recording the failure changes nothing the caller observes, and a failed turn stays distinguishable from `cancelled` and from a clean turn read from the file alone; a `'failed'` stop reason would be a value no provider produced |
| Consumer of `AgentRuntime.send` throws while reading the stream | Turn is recorded as `abandoned` (no `failure`), as for an early `break` | JavaScript delivers a for-await body's throw as a `return` completion, and it is honest: the turn did not fail, the reader left. Blaming the provider for darwin's own renderer bug would be worse than saying less |
| `trajectory` not a boolean | `ConfigError`, refuse to start | Recording the user believes is off (or on) but is not is a disk *and* a privacy surprise, and the record cannot reveal its own absence |
| Trajectory append fails (EACCES, full disk) | Latch the failure, stop recording for that session, keep the turn and its events untouched; surface once as a TUI `warn` notice after the turn, one bounded `trajectory:` stderr record in headless | Recording is an observer; it may not become a second reason a turn dies. Silence is not an option either — a later `replay` would show a short record with no explanation |
| Trajectory record formatting throws | Same latch, inside the synchronous observer; the event is still yielded | The caller of `AgentRuntime.send` must not be able to tell that recording exists |
| Recorder fails *while* recording a turn failure | Latch the recorder's problem and still rethrow the **turn's** error unchanged | Two failures at once must not become one confusing one: the caller needs the provider's error, and the recorder's is a separate, reported degradation |
| Trajectory file reaches its per-session byte budget | Append one `recordingStopped` record, stop recording that session, surface the problem | No session GC exists, so an unbounded record is a real disk risk; stopping with a marker keeps the prefix valid and honest |
| Payload exceeds a field or record cap | Truncate and record the truncation (path, original size, kept size) | "All there was" and "this was cut" must never be indistinguishable to a reader |
| Trajectory has a partial trailing line, or an interior malformed line | Skip and count it, report it on every read path, never rewrite the file | An interrupted write is expected in an append-only record; repairing it in place would destroy the only evidence |
| `trajectory search/replay` names a session with no record | Exit 1 naming the missing record; distinguish "session does not exist" from "session exists but was never recorded" | Zero results for a file that was never written is a lie |
| `trajectory search` finds nothing in records it did read | Print `no matches`, exit 0 | The search succeeded; only unreadable state is a failure |
| `trajectory fork` source has no snapshot, or the offload copy fails | Refuse the fork, create nothing, exit 1 | A fork that starts empty, or whose history cites offload references it cannot resolve, is worse than no fork |
| First `MaxTokensError` in an invocation | Retain its exact `partialMessage`, add an internal no-repeat continuation instruction, and retry the SDK model call once | The provider produced useful output; the supported `AfterModelCallEvent.retry` path preserves the SDK loop and configured thinking effort |
| Any later `MaxTokensError` in the same invocation | Retain that partial too, do not retry, propagate `MaxTokensError`; invocation snapshot persists all partials | Tool-loop model cycles reset `attemptCount`, so only invocation-scoped state can enforce one bounded continuation without false success |


## Common Mistakes

### Common Mistake: validating numbers with `Number.isFinite` only

**Symptom**: `maxTokens: 0` or `summaryRatio: 7` passes config loading and only explodes
later as an opaque Bedrock 400.
**Fix**: range-check every numeric config field at load time (`verify-config.ts` asserts
the ranges).

### Common Mistake: truncating UTF-8 text by byte length

**Symptom**: the truncated AGENTS.md injected into the system prompt ends in `�`.
**Cause**: `buffer.subarray(0, N).toString('utf8')` replaces a trailing incomplete
multi-byte sequence with U+FFFD; "cut at the last newline" doesn't save you when a single
line exceeds the budget.
**Fix**: `new StringDecoder('utf8').write(slice)` — it withholds incomplete trailing bytes
instead of replacing them (`src/agent/instructions.ts`; regression in `verify-agents-md.ts`).

### Common Mistake: cleanup that only works when nothing went wrong

**Symptom**: `/exit` hangs forever, but only in sessions that used bash or cancelled a turn.
**Cause**: relying on `beforeExit`-style cleanup — the leaked handle that makes cleanup
necessary is exactly what prevents `beforeExit` from firing.
**Prevention**: shutdown paths must be explicit (`runtime.shutdown()` in a `finally`),
resource-by-resource (`Promise.allSettled`, so one failure doesn't skip the rest), and
covered by a test that asserts the process actually exits within a deadline
(`exitedWithin()`, never an unbounded `exited()`).

## Global/project state layering

Application config is `~/.darwin/config.json`; global `permissionRules` is invalid. Rules are
project-scoped user state. Hooks and named resources layer global then project with project name
precedence, while malformed active policy files remain fatal and malformed optional entries stay
isolated. Sessions migrate copy-only from project `.darwin/` into project-keyed global storage.

### Contract: a suite that writes user-global state owns its HOME

`configPath(projectRoot)` **ignores its argument** and always resolves
`~/.darwin/config.json`; `permissionRulesPath()` and `saveThinkingEffort()` likewise resolve
under HOME. So a harness that writes a fixture through them writes the *developer's real*
configuration — and several of those fixtures are deliberately invalid, which then stops
darwin from starting until the file is restored by hand.

- Any suite that touches user-global state calls `ownPrivateHome(label)` from `spike/shared.ts`
  at module load, before deriving any global path. The helper fails immediately if the platform
  did not honour the change, and restores HOME plus deletes the temp home on process exit.
- The isolation is asserted in the suite, not assumed: each such suite's first assertion checks
  that `configPath()` resolves inside its owned HOME, so the guarantee fails loudly rather than
  silently landing on the real file.
- `spike/run-tests.ts` also hands each suite a private HOME. That is defence in depth, not the
  mechanism: suites are documented to run standalone (`pnpm tsx spike/verify-thinking.ts`), and
  standalone is exactly when the real config was clobbered.
- Suites owning HOME today: `verify-config`, `verify-thinking`, `verify-prompt-cache`,
  `verify-prompt-cache-live`, `verify-system-prompt`, `verify-model-command`,
  `verify-state-layers`, `verify-tui`, `verify-trajectory`. Adding a global write to any other
  suite means adding the call too.

**Verification**: snapshot `sha256sum ~/.darwin/config.json` and the `~/.darwin/projects/` entry
count, run the suites directly with the real HOME, and confirm both are unchanged.

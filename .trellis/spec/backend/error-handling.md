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
| MCP config malformed (`.darwin/mcp.json`, or root `.mcp.json` when it is the one in effect) | `ConfigError`, refuse to start | User asked for MCP and got none |
| One MCP server fails to connect / `${VAR}` unset | Skip it, keep starting (`continueOnError: true`) | One broken server must not kill the session; count shown in header |
| One skill directory broken (bad YAML, missing description, duplicate name) | Skip, record in `RuntimeInfo.skillProblems`, surface in header | Same isolation principle |
| `AGENTS.md` present but unreadable (EISDIR, EACCES) | Skip, record in `RuntimeInfo.projectInstructionsProblem`, surface in header | Same isolation principle: without the line, missing rules look like rules in effect |
| `AGENTS.md` absent, empty or whitespace-only | Skip silently, no header line | Nothing was asked for, so there is nothing to report |
| Tool call denied by user | `InterventionActions.deny(reason)` → error tool result | Model must see and react, loop must continue |
| `auto`-mode safety classifier fails (throw, timeout, unparseable reply) | Verdict forced to `safe: false` → user is prompted | Fail-closed: classifier degradation may cost an extra prompt, never a silent approval |
| bash command timeout / session death | SDK throws `BashTimeoutError` / `BashSessionError` → becomes an error tool result | Model retries or reports; not our code path |
| Turn cancelled (Ctrl+C) | `agent.cancel()`; stream ends with `stopReason: 'cancelled'`, no throw | Session stays usable; pending prompts released via `denyPending()` |

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

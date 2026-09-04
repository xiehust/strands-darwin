# Design — Permission approval modes

## Shape

One new concept, `ApprovalMode`, threaded from config/CLI into the existing gate. No new
process boundaries, no SDK loop changes. The mode decides *when to ask*; the
`PermissionBridge` (how to ask) and denial semantics are untouched.

```
config.json / CLI ──▶ AppConfig.permissionMode ──▶ AgentRuntime.create
                                                        │
                        PermissionGate({ mode, projectRoot, bridge, classifier? })
                                                        │
                              beforeToolCall ──▶ classify() ──▶ assessRisk()
                                                        │
                     yolo: proceed │ safe: proceed │ dangerous: [auto? classifier] → ask
```

## 1. Risk model (`src/agent/permission.ts`)

`PermissionRequest` gains:

```ts
risk: 'safe' | 'dangerous';
riskReason: string;          // human-readable, shown in the prompt box
```

`classify(toolName, input)` keeps its current kind/summary/details job. A new
`assessRisk(request, projectRoot)` layers the static rules on top:

- `kind === 'read'` → safe (`riskReason: 'read-only'`).
- `fileEditor` writes → resolve `path` against projectRoot (`path.resolve`, then
  `path.relative` check for `..` escape). Inside root and not sensitive → safe.
  Sensitive = any segment `.git`, basename matching `.env` / `.env.*`, or the file being
  `.darwin/config.json` (self-modification guard). Outside root → dangerous.
- `bash` → tokenize the command into segments on `&&`, `||`, `;`, `|`, `\n`. If the raw
  command contains `>`, `<`, `` ` ``, or `$(` → dangerous (redirection/substitution).
  Every segment's first word must be in `SAFE_BASH_COMMANDS`; `git` additionally requires
  its subcommand in `SAFE_GIT_SUBCOMMANDS` (status, log, diff, show, branch). Any miss →
  dangerous, reason names the offending segment.
- everything else (MCP, unknown) → dangerous (`riskReason: 'unrecognized tool'`).

Splitting on shell metacharacters without a real parser is deliberately naive — the rule
only *whitelists*; a mis-split can only cause a false "dangerous" (an extra prompt),
never a false "safe".

## 2. Gate (`src/agent/permission.ts`)

```ts
export type ApprovalMode = 'default' | 'auto' | 'yolo';

new PermissionGate({
  mode: ApprovalMode,
  projectRoot: string,
  ask: PermissionBridge,
  classifier?: SafetyClassifier,   // required when mode === 'auto'
})
```

`beforeToolCall` decision table:

| mode | risk safe | risk dangerous |
|------|-----------|----------------|
| yolo | proceed | proceed (reason: 'yolo mode') |
| default | proceed | ask bridge |
| auto | proceed | classifier verdict: safe → proceed; unsafe/error/timeout → ask bridge |

When auto's classifier flags a call, its `reason` is appended to the request's details
(label `Classifier`) before the bridge is asked, so the human sees why it escalated.
A classifier-unsafe verdict never auto-denies: auto-deny would strand the model in a
deny→explain loop; the human stays the arbiter for dangerous calls.

The constructor keeps a single-object signature so the old positional
`new PermissionGate(bridge)` call sites fail to compile rather than silently defaulting.

## 3. Safety classifier (`src/agent/safety-classifier.ts`, new)

```ts
export interface SafetyVerdict { safe: boolean; reason: string }
export type SafetyClassifier = (request: PermissionRequest) => Promise<SafetyVerdict>;
export function createModelClassifier(config: AppConfig, projectRoot: string): SafetyClassifier
```

- Model: `config.classifierModel` if set, else a cheap default per provider
  (bedrock → `global.anthropic.claude-haiku-4-5`, anthropic → `claude-haiku-4-5`,
  openai → `gpt-4o-mini`). Built via the existing `createModelFromConfig` with the model
  id and `maxTokens` overridden (~512).
- Invocation: a minimal single-shot call — no tools, no session manager, no plugins.
  Preferred: direct `model.stream()`/converse if the SDK exposes it cleanly; fallback: a
  throwaway `Agent` with `printer: false`. Whichever is used, record the contract in
  `.trellis/spec/backend/strands-sdk-contracts.md` with a probe script.
- Prompt: fixed instruction ("you are a safety classifier for a coding agent's tool
  calls; judge whether this call could damage the system, leak data, or act outside the
  project…") + tool name + pretty-printed input + projectRoot. Output contract: a single
  JSON object `{"safe": bool, "reason": string}`.
- Robustness: `Promise.race` with a 5s timeout; any throw, timeout, or unparseable
  output → `{ safe: false, reason: 'classifier unavailable — asking user' }`. Fail-closed
  is the whole point; degradation matches `error-handling.md` conventions.
- Lifecycle: created once in `AgentRuntime.create` when mode is `auto`; lazily
  initializes the model on first use so `default`/`yolo` sessions pay nothing. Verdicts
  for identical `(toolName, JSON.stringify(input))` pairs are memoized per session to
  avoid re-billing repeated identical calls.

## 4. Config (`src/config.ts`)

- `AppConfig.permissionMode: ApprovalMode` (default `'default'`),
  `AppConfig.classifierModel?: string`.
- Validation: `permissionMode` must be one of the three literals; otherwise
  `ConfigError` listing valid values (same style as the provider check).
- `classifierModel` reuses `stringField`; for bedrock it must pass the same
  inference-profile prefix check (validated in `createModelClassifier`, where the
  provider is known).

## 5. CLI (`src/cli.ts`)

- `--permission-mode <default|auto|yolo>` and shorthand `--yolo`.
- Precedence: CLI > config > built-in default. Parsed before `AgentRuntime.create`;
  invalid value → same plain stderr path as `ConfigError`.
- Plumbed as `RuntimeOptions.permissionModeOverride?: ApprovalMode`.

## 6. Runtime (`src/agent/runtime.ts`)

- Resolves the effective mode, constructs the classifier iff `auto`, passes both to
  `PermissionGate`.
- `RuntimeInfo.permissionMode: ApprovalMode` for the header.
- System prompt: the "Some tool calls need the user's approval" paragraph stays; it is
  true in all modes except yolo and harmless there.

## 7. TUI

- `App.tsx` header: `mode: default` (dim) / `mode: auto` (dim) / `mode: yolo` (yellow —
  it disables a safety layer, same color convention as other warnings).
- `PermissionPrompt.tsx`: shows `request.riskReason` next to the kind, e.g.
  `permission required (execute — not on the safe-command list)`. Classifier escalation
  reason arrives via the `Classifier` detail block, rendered by the existing detail loop.
- `PermissionQueue`, `dev-repl`, cancel/shutdown paths: unchanged. `allowAllBridge`
  remains for tests; yolo achieves the same effect one layer earlier.

## 8. Testing

- `spike/verify-permission-modes.ts` (new, added to `pnpm test`; no model, no network):
  table-driven assertions over `assessRisk` (bash allowlist incl. chained/redirected
  commands, path containment incl. `..` escape and sensitive files, unknown tools) and
  over `PermissionGate` with stub bridge/classifier: per-mode ask/proceed/deny outcomes,
  classifier timeout → ask, classifier throw → ask.
- `spike/verify-classifier.ts` (new, model-calling, run individually): `rm -rf /` →
  unsafe; `git status` → safe; malformed-output resilience.
- `spike/verify-tui.ts`: `approve`/`deny` scenarios switch their gated action to a
  non-allowlisted bash command (file edits no longer prompt under `default`); new
  `safePassthrough` scenario asserts `git status` produces *no* prompt; existing
  `bashExit`/`cancelThenContinue` unaffected (bash commands they use still prompt).
- pty assertions follow `.trellis/spec/frontend/tui-testing.md` (anchored waits,
  state-exclusive strings).

## Rejected alternatives

- **Dangerous-command denylist** for `default`: a static denylist necessarily misses;
  whitelist-with-fail-closed can only err toward an extra prompt.
- **Auto-deny on classifier-unsafe in `auto`**: strands the agent; the human should
  arbitrate exactly the calls the classifier is unsure about.
- **Fourth "strict" mode preserving today's ask-everything behavior**: out of scope per
  request; trivial to add later (one more row in the decision table).

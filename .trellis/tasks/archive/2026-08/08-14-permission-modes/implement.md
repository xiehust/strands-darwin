# Implementation plan — Permission approval modes

Ordered checklist. Validation gate after each numbered step: `pnpm typecheck`.

## 1. Risk model + gate (src/agent/permission.ts)

- [x] Add `ApprovalMode`, `risk`/`riskReason` on `PermissionRequest`, `assessRisk()`
      with static rules (bash allowlist + metacharacter check, fileEditor path
      containment + sensitive paths, unknown → dangerous).
- [x] Rework `PermissionGate` to options-object constructor
      `{ mode, projectRoot, ask, classifier? }` and the per-mode decision table.
- [x] Export `SafetyClassifier`/`SafetyVerdict` types (from permission.ts or the
      classifier module — keep the import graph acyclic: permission.ts must not import
      config.ts).

## 2. Fast verification suite (spike/verify-permission-modes.ts)

- [x] Table-driven `assessRisk` cases: `git status` safe; `git push` dangerous;
      `ls && rm x` dangerous; `cat a | grep b` safe; `echo hi > f` dangerous;
      in-project `str_replace` safe; `../outside` and `.env` / `.git/config` /
      `.darwin/config.json` dangerous; MCP tool name dangerous; `bash restart` safe.
- [x] Gate cases with stub bridge (records asks) + stub classifier: three modes ×
      safe/dangerous; auto with classifier-safe (no ask), classifier-unsafe (ask, detail
      block appended), classifier-throw and classifier-hang (timeout) → ask.
- [x] Wire into `pnpm test` in package.json.

## 3. Config (src/config.ts)

- [x] `permissionMode` (validated literal, default `'default'`), `classifierModel`
      (optional string). Extend `spike/verify-config.ts` with valid/invalid cases.

## 4. Classifier (src/agent/safety-classifier.ts)

- [x] Probe how to make a one-shot no-tool model call with the SDK (throwaway
      `Agent({ printer: false })` vs direct model API); record findings + probe script
      in `.trellis/spec/backend/strands-sdk-contracts.md` per project convention.
- [x] `createModelClassifier(config, projectRoot)`: per-provider default model ids,
      strict-JSON prompt, 5s timeout, fail-closed on throw/timeout/unparseable, per-run
      memoization keyed on `(toolName, JSON.stringify(input))`.
- [x] `spike/verify-classifier.ts` (model-calling, not in `pnpm test`).

## 5. Runtime + CLI (src/agent/runtime.ts, src/cli.ts)

- [x] `RuntimeOptions.permissionModeOverride?`, effective-mode resolution,
      classifier construction iff auto, `RuntimeInfo.permissionMode`.
- [x] `--permission-mode <m>` / `--yolo` parsing with plain-stderr error path.
- [x] `src/dev-repl.ts`: compile against new gate wiring (keeps `allowAllBridge`).

## 6. TUI (src/tui/)

- [x] Header mode line (yellow for yolo), `PermissionPrompt` shows `riskReason`.

## 7. Pty scenarios (spike/verify-tui.ts)

- [x] Adapt `approve`/`deny` to gate on a non-allowlisted bash command.
- [x] New `safePassthrough` scenario: `git status`-style task completes with zero
      permission prompts under `default`.
- [x] Run: `AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts approve` / `deny` /
      `safePassthrough` / `bashExit` / `cancelThenContinue`.

## 8. Docs & wrap-up

- [x] CLAUDE.md: permissions paragraph gains the three modes; config example.
- [x] Spec update: `.trellis/spec/backend/error-handling.md` degradation table row
      (classifier failure → ask, never silent allow); sdk-contracts entry from step 4.
- [x] Full check: `pnpm typecheck && pnpm test`, model suites from step 7,
      `AWS_REGION=us-west-2 pnpm tsx spike/verify-step-1-2.ts` (gate wiring touched).

## Rollback

Single revert point: all changes are additive around the existing gate; reverting the
task's commits restores ask-everything behavior. No data/session format changes.

## Review gates

- After step 2: risk table output reviewed against PRD acceptance list.
- After step 7: pty transcripts checked for the exact prompt/no-prompt assertions.

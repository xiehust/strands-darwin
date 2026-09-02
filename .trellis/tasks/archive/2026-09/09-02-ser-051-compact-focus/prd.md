# SER-051 `/compact <focus>` — per-call compaction manager with the SDK default prompt plus one bounded focus section

## Goal

`/compact` refuses arguments (`src/tui/App.tsx`, notice `/compact takes no arguments`) and the
runtime builds one process-lifetime `compactionManager` with no `summarizationSystemPrompt`, so
the user cannot tell the summarizer what this summary must keep. Accept optional focus text:
build the `SummarizingConversationManager` per `compact()` call; when a focus is given, its
system prompt is the SDK's `DEFAULT_SUMMARIZATION_PROMPT` followed by exactly one fixed section
carrying the trimmed focus. `/compact` without text and headless `--compact-before` behave
exactly as today.

Origin: `docs/research/backlog/directions-061-080.md` § SER-051 (Notes subsection is the
contract); report `docs/research/research_2026-09-02.md` (run 02:29:40Z).

## Requirements

- The default prompt is reached through the package root: extend the pinned
  `patches/@strands-agents__sdk@1.12.0.patch` so `dist/src/index.js` / `index.d.ts` re-export
  `DEFAULT_SUMMARIZATION_PROMPT`, then `import { DEFAULT_SUMMARIZATION_PROMPT } from
  '@strands-agents/sdk'`. Never a copied prompt string, never a deep import (the package
  `exports` map does not expose it). If the patch cannot be regenerated so that
  `pnpm install --frozen-lockfile` reapplies it, stop and report.
- Unfocused: `new SummarizingConversationManager({ summaryRatio: 0.8, preserveRecentMessages })`
  — no `summarizationSystemPrompt` key at all, so the SDK default applies and the summarizer
  request is byte-identical to today's. Same summary message shape (user-role, non-reasoning
  blocks only).
- Focused: focus is trimmed; empty after trim = unfocused. Cap **400 code points**; over-cap is
  refused with a notice before hooks and before any model call — compaction does not run.
  System prompt = `DEFAULT_SUMMARIZATION_PROMPT` + `\n\n` + one fixed heading naming it as the
  user's focus for this summary + the focus text. The focus is plain text only, never parsed.
- `runtime.compact(focus?)`: optional parameter; `--compact-before` calls it with no argument.
  `PreCompact`/`PostCompact` codex hooks keep `trigger: manual`; payloads unchanged.
- The reasoning-block scrub in the pinned `generateSummary` applies to focused summaries too.
- TUI: `/compact <focus>` is recorded as a `userInput` transcript action exactly as `/compact`
  is today; compaction keyboard ownership unchanged; busy refusal (`refusesToQueue` matches on
  the first word) unchanged.
- `/help` (via `BUILTIN_COMMAND_DESCRIPTIONS.compact`, one phrase, name list unchanged so
  `MAX_COMPLETIONS` does not move), `docs/user-guide/reference.md` and `reference.zh-CN.md`
  state the optional argument and the cap.

## Requirement → check checklist

| Requirement | Check |
|---|---|
| unfocused compaction sends the summarizer exactly `DEFAULT_SUMMARIZATION_PROMPT`; summary message shape unchanged | `spike/verify-compact.ts` — `DeterministicModel` records `options.systemPrompt`; assert equality; existing shape/rollback/no-op assertions unchanged |
| unfocused manager config has no `summarizationSystemPrompt` key | `verify-compact.ts` — `compactionManagerConfig(n)` deep-equals `{ summaryRatio: 0.8, preserveRecentMessages: n }` |
| focused prompt = default prompt verbatim + focus exactly once | `verify-compact.ts` — `startsWith(DEFAULT_SUMMARIZATION_PROMPT + '\n\n')`, focus occurs once, default prompt occurs once |
| focus trimmed; blank focus = unfocused | `verify-compact.ts` — `normalizeCompactFocus('  x  ') === 'x'`, `('   ') === undefined` |
| over-cap focus refused before hooks/model | `verify-compact.ts` — 401 code points → `compactFocusRefusal()` notice; `compactConversation` with an over-cap focus throws before `model.stream` is called (stream count 0, messages untouched) |
| reasoning scrub applies to a focused summary | `verify-compact.ts` — reasoning-emitting model + focus → no user message carries a reasoning block, summary text present |
| root import, never deep path or copied string | `verify-compact.ts` — reads `src/agent/compact.ts` source: root `'@strands-agents/sdk'` import of `DEFAULT_SUMMARIZATION_PROMPT`, no `context-compression` path, no `You are a conversation summarizer` literal |
| `/compact <focus>` reaches `runtime.compact(focus)`; `/compact` reaches `runtime.compact()`; `--compact-before` unchanged | code review of `App.tsx` and `headless-runner.ts`; `spike/verify-tui.ts compacting` (live) green |
| `/help` + completion description state the argument | `spike/verify-help-command.ts`, `spike/verify-tui.ts completion` |
| patch reapplies cleanly | `pnpm install --frozen-lockfile` then `pnpm typecheck` |
| gate | full `pnpm test` (exit 0, zero FAIL), `pnpm build` |

## Acceptance Criteria

- [x] Extended pinned patch re-exports `DEFAULT_SUMMARIZATION_PROMPT`; `pnpm install --frozen-lockfile` reapplies it; lockfile patch hash updated.
- [x] `spike/verify-compact.ts` covers every checklist row above and passes.
- [x] `.trellis/spec/backend/strands-sdk-contracts.md` states the `/compact` focus contract and the new patch hunk; AGENTS.md index row + `docs/architecture/load-bearing-decisions.md` section added.
- [x] `reference.md` / `reference.zh-CN.md` / `/help` state the optional argument.
- [x] `pnpm typecheck` clean, full `pnpm test` green, `pnpm build` run.

## Verification (2026-09-02)

- `pnpm patch` / `pnpm patch-commit` extended the pinned patch with exactly two hunks (`dist/src/index.js`, `dist/src/index.d.ts`); `pnpm install --frozen-lockfile` reapplies it; lockfile patch hash updated.
- `spike/verify-compact.ts` 52/52; `spike/verify-help-command.ts` 34/34; `spike/verify-tui.ts completion` 68/68.
- `pnpm typecheck` clean after fresh apply; full `pnpm test` exit 0, zero FAIL lines (82 suites); `pnpm build` clean.
- `spike/verify-tui.ts compacting` (live, Opus 5 / effort high) timed out twice at 240s waiting for the compaction result — and timed out identically on the pre-change tree (`git stash` baseline at `49dd197`), so it is pre-existing environment behavior, not a SER-051 regression. Reported to the Host.

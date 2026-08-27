# SER-041 — Clipboard image attachment

## Goal

Let an interactive Darwin user attach one image currently held by the operating-system clipboard to the next ordinary prompt. Show the pending attachment as bounded composer state and send it as an SDK `ImageBlock` in the same invocation as the prompt text.

## Requirements

1. Reuse `src/tools/image-viewer.ts` image validation/normalization limits and decoder policy. The existing path-based `imageViewer` tool remains unchanged and available.
2. Use the installed Strands SDK content-block invocation path. Do not fork/intercept the SDK loop; `src/agent/runtime.ts` remains the only production `Agent` constructor.
3. The attachment is interactive-driver state only. It survives ordinary draft editing, completion, recall/reverse-search, Escape, and bracketed/multiline text paste. It is removed only explicitly or once its prompt is actually accepted for local handling/queue/send.
4. Use a discoverable keyboard gesture that does not steal existing ownership. Surface the gesture and removal control in the composer/help contract.
5. Clipboard acquisition has no package dependency. Unsupported platform/session, missing clipboard helper, non-image clipboard data, helper failure, invalid/oversized/unsupported data, and provider rejection are explicit. Acquisition/validation failure leaves the existing draft and attachment unchanged.
6. Queue entries own their image attachment. Drain sends the matching image exactly once; take-back and cancellation return it visibly unsent; `/clear` drops queued state with the old conversation. No image attaches to local slash commands or `!` shell commands.
7. Trajectory, replay/export, prompt recall, memory evidence, rewind catalogue, and shell records stay text-only. They record the literal submitted text; a bounded attachment fact may appear only on live TUI surfaces, never image bytes, clipboard payload, base64, or a fabricated path.
8. The chip/list projection and all notices are bounded and counted by the one frame budget.

## Acceptance

- Deterministic offline coverage captures one ordinary `AgentRuntime.send` SDK invocation containing prompt text plus exact normalized image bytes, with one provider/model call.
- Focused real-pty coverage proves attach, persistent chip across edits, explicit removal, failed read retention, ordinary send clearing, queue ownership/drain/take-back/cancel behavior, and unchanged multiline/bracketed paste/key ownership.
- Existing image-viewer tests prove shared decoder behavior and path tool preservation.
- Executable SDK/TUI/error contracts and load-bearing architecture indexes describe the invariant.
- `pnpm typecheck`, complete `pnpm test`, and `pnpm build` pass; no provider/model-calling live suite runs.

## Out of scope

- Drag/drop, file-picker, arbitrary attachment types, persisted images, image replay/export, headless image-input CLI syntax, multiple clipboard images in one clipboard read, or model/provider capability probing via a second call.
- Changes to Host-owned research status/evidence, backlog final status, or `docs/iteration-log.md`.
